/**
 * valorant-clutch-detection
 * ─────────────────────────
 * Reconstructs 1vX clutch situations from raw Riot / HenrikDev match data —
 * detecting WHETHER a clutch happened and of what type (1v1 through 1v5), with
 * correct handling of the two revive abilities (Sage Resurrection, Clove Not
 * Dead Yet) that make a naive "who died last" count wrong.
 *
 * Riot's match API exposes NO clutch flag anywhere (not on the round object,
 * not on per-player round stats), so everything here is reconstructed from the
 * kill feed, plant/defuse events, and the positional snapshots (player_locations)
 * attached to those events.
 *
 * ── Pipeline ───────────────────────────────────────────────────────────────
 *   1. presentCount(teamPlayers, roundData, roundKills)
 *        → starting alive-count for a side (excludes AFK / never-spawned)
 *   2. computeRealDeaths(roundKills, roundData, players)
 *        → { realDeath: {puuid: ms}, unresolved: Set<puuid> }
 *          filters out revived deaths; flags the genuinely-undeterminable ones
 *   3. detectClutch(roundKills, realDeath, pTeam, puuid, startMyAlive, startEnemyAlive)
 *        → null, or { clutchType, clutchStartMs, killsAfterClutch, killTimes,
 *                     enemyAliveAfterLastKill, deathMs }
 *
 * ── Minimal usage ──────────────────────────────────────────────────────────
 *   Per match, group kills by round, then for the player you're tracking:
 *
 *     const killsByRound = [];
 *     match.kills.forEach(k => (killsByRound[k.round] ??= []).push(k));
 *     killsByRound.forEach(a => a.sort((x,y)=>(x.time_in_round_in_ms??0)-(y.time_in_round_in_ms??0)));
 *
 *     for (let r = 0; r < match.rounds.length; r++) {
 *       const roundData  = match.rounds[r];
 *       const roundKills = killsByRound[r] || [];
 *       const { realDeath, unresolved } = computeRealDeaths(roundKills, roundData, match.players);
 *
 *       const myTeam    = me.team_id.toLowerCase();
 *       const myRoster  = match.players.filter(p => p.team_id.toLowerCase() === myTeam);
 *       const enemyRost = match.players.filter(p => p.team_id.toLowerCase() !== myTeam);
 *       const startMy    = presentCount(myRoster,  roundData, roundKills);
 *       const startEnemy = presentCount(enemyRost, roundData, roundKills);
 *
 *       const c = detectClutch(roundKills, realDeath, myTeam, me.puuid, startMy, startEnemy);
 *       if (!c) continue; // no clutch this round
 *
 *       // c.clutchType is the 1vX (1–5). c.clutchStartMs is when it began.
 *       // unresolved.size > 0 → this round contains an ambiguous
 *       // (possibly-revived) death; treat any stat derived from it as
 *       // provisional. See the README for how that's handled downstream.
 *     }
 *
 * Data shape expected (Riot v4 / HenrikDev): a kill has { round, killer:{puuid,team},
 * victim:{puuid,team}, time_in_round_in_ms, weapon:{name}, player_locations:[{player:{puuid}}] };
 * a round has { result, winning_team, plant?:{round_time_in_ms,player_locations,player:{team}},
 * defuse?:{round_time_in_ms,player_locations} }; a player has { puuid, team_id, agent:{name} }.
 * Field-name fallbacks (player_locations_on_kill, player_puuid) cover older API versions.
 *
 * Extracted verbatim from a working tool. MIT-licensed — use freely.
 */

/* ═══════════════════════════════════════════════════════════════════════
   CLUTCH DETECTION

   Definition used here: a clutch is any moment where every teammate who
   was actually playing the round is dead, you are still alive, and at
   least one enemy remains. The 1vX number is however many enemies were
   alive at that instant.

   Riot's API exposes no pre-computed clutch flag, so this is
   reconstructed from the raw kills array (each kill carries a round
   index, a killer/victim with team, a timestamp, and the weapon used).
   Three things make that reconstruction harder than it sounds. Each one
   caused a real, confirmed bug before it was handled:

     1. REVIVES — a death in the kill feed isn't always permanent. Sage
        resurrection and Clove's self-revive put a player back in the
        round, so counting every death entry over-counts how many
        teammates are actually down.
     2. ABSENT PLAYERS — a disconnected teammate never dies. Waiting for
        a death that will never come means the "last one alive" trigger
        never fires, hiding real clutches entirely.
     3. POSTHUMOUS KILLS — lingering utility (a Tejo missile in flight, a
        Killjoy turret, a trap, a molly still ticking) scores kills after
        its owner is already dead for good. That looks identical to a
        revive if you only check "did they get a kill after dying."

   Validated against two ground truths that don't depend on this code
   being right: Riot's own CeremonyClutch round tag, and an
   Elimination-round cross-check (the losing side must have exactly as
   many real deaths as it had players on the field). Across two
   independent datasets — 140 and 123 matches, different players and
   ranks — CeremonyClutch matched 144/144 and 108/108 with zero misses,
   and Elimination mismatches were 0 on both.

   Note on ceremony: CeremonyClutch is reliable when present but far too
   sparse to detect with. Riot shows only one badge per round with
   Ace/TeamAce/Thrifty/Closer taking priority over Clutch, never badges
   losses at all, and skips most genuine 1v1s (measured: ~2% of true 1v1
   wins get the tag, vs ~63% of 1v2s). Confirmed cases exist of an
   unambiguous 15-second solo 1v1 win still tagged CeremonyDefault. It's
   used as a verification signal in the debug panel, never as the source.
   ═══════════════════════════════════════════════════════════════════════ */

/* ── Tunables ─────────────────────────────────────────────────────── */

// A weapon kill credited to a player this soon after their own death is
// read as timestamp jitter on a near-simultaneous trade, not proof they
// were revived and playing on. Calibrated against confirmed examples on
// both sides: a genuine Sage revive showed an 8.7s gap between the
// "death" and the player's next rifle kill, while a real trade (verified
// independently by that round's CeremonyClutch tag) showed 1.3s.
const REVIVE_MIN_GAP_MS=3000;

// Boundary constants for the Clove revive-window check in computeRealDeaths
// (Step 2b). Not Dead Yet's own safety net ("survives if the round ends
// while the timer is still ongoing") is NOT the same boundary as the
// round's outcome being decided — her timer keeps running through the
// Post-Round Phase and can still expire and kill her during it; she's
// only safe once the NEXT Buy Phase actually begins. So the correct
// boundary is nominal Round Phase (100s, or 45s post-plant) PLUS the
// confirmed 7s Post-Round Phase. Buy Phase is separate and NOT included
// in time_in_round_in_ms (confirmed empirically: if it were, unplanted-
// round kills would top out near 130s, but the observed max across 113
// matches was 106.7s, matching nominal Round Phase + the 7s Post-Round).
const POST_ROUND_PHASE_MS=7000;
const CLOVE_REVIVE_SPIKE_BOUNDARY_MS=45000+POST_ROUND_PHASE_MS;
const CLOVE_REVIVE_ROUND_BOUNDARY_MS=100000+POST_ROUND_PHASE_MS;

// Absolute ceiling on how long a Clove's own self-revive attempt
// (Not Dead Yet) can take from her original death to needing a kill or
// damaging assist locked in. Built from confirmed values — 1.5s revive
// windup + up to 2s intangibility + 0.8s deactivation + 10s resurrection
// timer = 14.3s — plus Riot's own description of "a couple of seconds"
// to decide and activate in the first place, generously rounded up to
// 3s (14.3s + 3s = 17.3s). Cross-checked against 38 confirmed real Not
// Dead Yet timeouts in this exact dataset: the largest observed gap
// between an original death and the timeout kill was 16.86s, comfortably
// under this ceiling — so it's a validated bound, not just a paper one.
// See computeRealDeaths case 2b for how this gets used.
const MAX_CLOVE_SELF_REVIVE_WINDOW_MS=17300;

/* ── Step 1 · Who was actually in this round? ─────────────────────── */

// Primary method: DIRECT OBSERVATION via the positional snapshot Riot
// attaches to the plant and defuse events (rounds[r].plant.player_locations).
// That snapshot lists every player alive at that instant with their map
// coordinates — it's literally the data tracker.gg renders as the round
// minimap. A player who never spawned simply isn't in it.
//
// So: a player is ABSENT from the round if they're missing from the
// snapshot AND have no death event before it. Missing-but-died is just
// someone who was already killed; missing-and-never-died never spawned.
//
// Use RAW death events here, not the revive-adjusted ones from
// computeRealDeaths. A revived player was genuinely dead at the snapshot
// moment, so their absence IS explained — but the revive logic erases
// that death, which would make them look like they never spawned.
// (Confirmed: four separate players flagged this way before the fix, all
// of them ordinary revives, all four false positives.)
//
// Fallback: received_penalty, for the ~40% of rounds with no plant or
// defuse (eliminations before the plant, or time expiry) and therefore no
// snapshot to read.
//
// Validated against each other across 3,205 rounds that DO have a
// snapshot, over two independent datasets: the two methods agree on
// every single player-round, zero disagreements in either direction.
// The snapshot is preferred anyway because it's direct observation
// rather than a flag, so it can't be defeated by a short AFK stint that
// never trips Riot's penalty threshold.
//
// Two earlier approaches were tried and both proved wrong:
//   · Inferring from the kill feed ("last round they appear in") — a
//     present, live player can go several rounds with no kills and no
//     deaths, and that heuristic read those quiet rounds as disconnects,
//     inventing clutch situations that never happened.
//   · was_afk — turned out to mean "took zero actions this round," which
//     fires for a present-but-idle player just as often as for someone
//     truly gone (confirmed: a round with was_afk=true, a real weapon in
//     the loadout, and no penalty — that player was still on the field
//     and still killable). It also failed the other way, with a
//     confirmed-gone player showing was_afk=false.
//
// Deliberately NOT used: stayed_in_spawn. A player who hides in spawn
// all round is still alive and still killable, so they legitimately
// count toward the roster — excluding them would fire the last-alive
// trigger early and invent clutches. It's a signal for judging effort,
// not presence.
function presentCount(teamPlayers,roundData,roundKills){
  // Gather every positional snapshot available this round, then use the
  // EARLIEST one — the fewer players who've died by that point, the fewer
  // absences need explaining away via the kill feed.
  //
  // Sources, best coverage first:
  //   1. Kill events (player_locations / player_locations_on_kill). Every
  //      round with at least one kill gets a snapshot, so this covers
  //      essentially all rounds — including the ~40% with no plant or
  //      defuse. Field naming differs between API versions, so both are
  //      accepted. Absent from the v4 matchlist payload as currently
  //      fetched; present in v2's match endpoint. Handled defensively so
  //      it starts working automatically the moment richer data is fed in.
  //   2. Plant / defuse events (player_locations). Always present in v4,
  //      but only exist on rounds that actually had a plant or defuse.
  const snaps=[];
  (roundKills||[]).forEach(k=>{
    const locs=k.player_locations||k.player_locations_on_kill;
    if(locs?.length)snaps.push({ms:k.time_in_round_in_ms??0,locs});
  });
  if(roundData.plant?.player_locations?.length)
    snaps.push({ms:roundData.plant.round_time_in_ms,locs:roundData.plant.player_locations});
  if(roundData.defuse?.player_locations?.length)
    snaps.push({ms:roundData.defuse.round_time_in_ms,locs:roundData.defuse.player_locations});

  if(snaps.length&&roundKills){
    const snap=snaps.reduce((a,b)=>b.ms<a.ms?b:a);
    // Snapshot entries are {player:{puuid}} in v4, {player_puuid} in v2.
    const seenAlive=new Set(snap.locs.map(l=>l.player?.puuid||l.player_puuid).filter(Boolean));
    const diedBySnapshot=new Set();
    roundKills.forEach(k=>{
      if(k.victim?.puuid&&(k.time_in_round_in_ms??0)<=snap.ms)diedBySnapshot.add(k.victim.puuid);
    });
    return teamPlayers.filter(p=>seenAlive.has(p.puuid)||diedBySnapshot.has(p.puuid)).length;
  }

  // No positional data at all this round — fall back to Riot's penalty flag.
  const active={};
  (roundData.stats||[]).forEach(s=>{active[s.player.puuid]=!s.received_penalty;});
  return teamPlayers.filter(p=>active[p.puuid]===true).length;
}

/* ── Step 2 · When did each player REALLY die? ────────────────────── */

// Resolves each player's permanent death for the round, filtering out
// deaths undone by a revive (Sage resurrection, Clove self-revive).
//
// Returns { realDeath: {puuid: deathMs}, unresolved: Set<puuid> }.
// A player absent from realDeath never permanently died that round.
// A player in `unresolved` has a death we could not verify either way —
// it is provisionally recorded as real, but flagged so callers can
// exclude the round rather than trust a guess.
//
// PRIMARY GATE, checked once per player before anything else: was a
// revive even mechanically possible for them this round? The only two
// revive mechanics in the game are Clove's self-revive and Sage's
// resurrection. If the player isn't Clove and no Sage exists anywhere on
// their team, no revive could have happened — their first death is the
// real one, full stop, with no snapshot walk, no elimination-result
// gate, and no risk of landing in `unresolved`. Measured: this closes
// the gate immediately for 79% of all death events (players who aren't
// Clove and have no Sage teammate) — the detailed walk below only ever
// runs for the remaining 21%.
//
// For the gate-open cases, primary signal is positional. Every kill
// event carries player_locations, a snapshot of everyone alive at that
// instant (~99.8% round coverage). A revived player is absent from
// snapshots taken while dead, then reappears in a later one — direct
// observation of aliveness over time, not inference from kill timing.
//
// This replaced an earlier kill-timing heuristic ("got a weapon kill
// >3s after dying, so they must have been revived"). Measured against
// positional data across 537 matches, that heuristic found 257 revives
// — of which positional confirmed 256 and refuted 1 — while missing
// 1,212 real revives it had no way to see. It also can't be repaired by
// tightening the weapon check: a confirmed case has a player dead for
// good, never reappearing in any snapshot, credited a normal Vandal
// kill 5.3s later. Riot's own client shows that kill at 0m distance, the
// same degenerate signature seen on environmental kills — the engine
// retroactively credits a death to whoever last damaged the victim,
// carrying their weapon and a meaningless position. No field on the
// kill record separates that from a genuine post-revive kill; only the
// positional snapshot does.
//
// Resolution order per death event (gate-open players only), earliest
// death first:
//
//   1. A snapshot exists after this death:
//        · player reappears in one  → this death was undone; keep
//          walking to their next death event
//        · player never reappears   → this death is real
//
//   2. No snapshot exists after this death (almost always the round's
//      final kill — 99.3% of such cases). Try to settle it anyway:
//        · Round ended by Elimination and this player's team lost → the
//          whole losing side must be dead, so no revive succeeded →
//          death is real. (Resolves the large majority of such cases.)
//        · Otherwise → UNRESOLVED. ~0.24% of all deaths, all in
//          Detonate/Defuse rounds where a revived player could
//          genuinely still be alive at round end.
//
// An earlier version treated an Ability-tagged death (weapon.type !==
// 'Weapon', e.g. "Not Dead Yet" — Clove's ultimate expiring) as always
// final, on the reasoning that it's an unambiguous marker of Clove's own
// revive attempt failing. That's true as far as it goes, but it doesn't
// mean the player is done — a Sage can resurrect a body regardless of
// what killed it, including a body that arrived at "Not Dead Yet" via a
// failed self-revive. Confirmed real case: a Clove's ult expires, and
// she reappears in a later positional snapshot — her Sage teammate
// revived her after her own attempt failed. So every death, ability-
// tagged or not, gets the same positional check; nothing is trusted as
// final just because of how it's labeled.
//
// Killer identity is deliberately unused. Gating on "a different killer
// than the previous death entry" was tried and failed on a real case:
// two normal-weapon deaths credited to two different enemies turned out
// to be one ordinary death, not a revive.
function computeRealDeaths(roundKills,roundData,players){
  const agentOf={},teamOf={};
  (players||[]).forEach(p=>{agentOf[p.puuid]=p.agent?.name;teamOf[p.puuid]=p.team_id?.toLowerCase();});

  const sageOnTeam={};
  (players||[]).forEach(p=>{if(p.agent?.name==='Sage')sageOnTeam[teamOf[p.puuid]]=true;});

  const deathsByVictim={};
  for(const k of roundKills){
    const victim=k.victim?.puuid;
    if(!victim)continue;
    (deathsByVictim[victim]??=[]).push(k.time_in_round_in_ms??0);
  }

  const realDeath={},unresolved=new Set();

  for(const puuid in deathsByVictim){
    const deaths=deathsByVictim[puuid].sort((a,b)=>a-b);

    // Primary gate — skip the entire walk when a revive was never on
    // the table for this player.
    const reviveEverPossible=agentOf[puuid]==='Clove'||sageOnTeam[teamOf[puuid]];
    if(!reviveEverPossible){
      realDeath[puuid]=deaths[0];
      continue;
    }

    // Gate open — build snapshots (only needed here, so built lazily)
    // and walk each death event in order. Kill events aren't the only
    // source: the plant and defuse events also carry a player_locations
    // snapshot (same data presentCount already uses in Step 1), and
    // those often land AFTER a round's last kill — exactly the case
    // that otherwise falls through to unresolved for lack of any later
    // snapshot to check.
    const snaps=[];
    for(const k of roundKills){
      const locs=k.player_locations||k.player_locations_on_kill;
      if(!locs?.length)continue;
      snaps.push({ms:k.time_in_round_in_ms??0,alive:new Set(locs.map(l=>l.player?.puuid||l.player_puuid).filter(Boolean))});
    }
    if(roundData?.plant?.player_locations?.length)
      snaps.push({ms:roundData.plant.round_time_in_ms,alive:new Set(roundData.plant.player_locations.map(l=>l.player?.puuid||l.player_puuid).filter(Boolean))});
    if(roundData?.defuse?.player_locations?.length)
      snaps.push({ms:roundData.defuse.round_time_in_ms,alive:new Set(roundData.defuse.player_locations.map(l=>l.player?.puuid||l.player_puuid).filter(Boolean))});
    snaps.sort((a,b)=>a.ms-b.ms);

    const firstDeathOf={};
    for(const pu in deathsByVictim)firstDeathOf[pu]=Math.min(...deathsByVictim[pu]);

    for(const t of deaths){
      // 1 · Positional evidence available? Checked first for EVERY
      // death, including an Ability-tagged one ("Not Dead Yet" — Clove's
      // own revive failing). That death is not automatically final: a
      // Sage can resurrect a body regardless of what killed it, so a
      // Clove who fails her own revive attempt can still be brought back
      // by a teammate afterward. Confirmed real case: a Clove's ult
      // expires (Not Dead Yet), and she reappears in a later snapshot —
      // her Sage teammate revived her after her own revive attempt
      // failed. An earlier version trusted the ability tag as always
      // final and got this wrong.
      const later=snaps.filter(s=>s.ms>t);
      if(later.length){
        if(later.some(s=>s.alive.has(puuid)))continue;  // came back — death undone
        realDeath[puuid]=t;break;                        // stayed dead — real
      }

      // 2 · No positional evidence after this death — does the round
      // result settle it? (The Clove/Sage possibility check already
      // happened at the gate above, so only the elimination gate
      // remains here.)
      const sageAliveNow=(players||[]).some(p=>
        p.puuid!==puuid&&teamOf[p.puuid]===teamOf[puuid]&&agentOf[p.puuid]==='Sage'&&
        (firstDeathOf[p.puuid]===undefined||firstDeathOf[p.puuid]>t));
      const couldSelfRevive=agentOf[puuid]==='Clove';
      const teamWipedOut=roundData?.result==='Elimination'&&
        roundData.winning_team?.toLowerCase()!==teamOf[puuid];

      if((!couldSelfRevive&&!sageAliveNow)||teamWipedOut){
        realDeath[puuid]=t;break;                        // settled — real
      }

      // 2b · Clove-specific timing bound. Not Dead Yet requires a kill
      // or damaging assist within its resurrection timer — which would
      // itself be a kill event in roundKills — or the round ending
      // while that timer is still running, which lets her survive with
      // no kill needed at all. If NEITHER happened (no kill anywhere
      // later in the round, AND the round ran on long enough afterward
      // that the timer would have expired regardless of when she
      // activated), a successful revive isn't just unproven, it's ruled
      // out mechanically. Only applies when Clove's own ult is the sole
      // possible revive route — a live Sage teammate can revive at any
      // point up to round end with no timer of their own, so this bound
      // doesn't constrain that case.
      if(couldSelfRevive&&!sageAliveNow){
        const noMoreKillsThisRound=!roundKills.some(k=>(k.time_in_round_in_ms??0)>t);
        const roundEndEstimate=roundData?.plant?.round_time_in_ms!=null
          ?roundData.plant.round_time_in_ms+CLOVE_REVIVE_SPIKE_BOUNDARY_MS
          :CLOVE_REVIVE_ROUND_BOUNDARY_MS;
        if(noMoreKillsThisRound&&(roundEndEstimate-t)>MAX_CLOVE_SELF_REVIVE_WINDOW_MS){
          realDeath[puuid]=t;break;                        // timing rules out a revive — real
        }
      }

      unresolved.add(puuid);
      realDeath[puuid]=t;                                // provisional
      break;
    }
  }

  return{realDeath,unresolved};
}

/* ── Step 3 · Was there a clutch, and what kind? ──────────────────── */

// Walks the round's kills in order, tracking how many players are left
// standing on each side, and fires the moment the tracked player becomes
// their team's sole survivor with enemies still up.
//
// startMyAlive / startEnemyAlive must come from presentCount (Step 1),
// NOT hardcoded to 5. With a disconnected teammate the trigger condition
// (myAlive===1) needs one more death than will ever occur, so the whole
// situation stays invisible. Cross-checking Elimination rounds found 83
// clutch situations in a single dataset hidden by exactly this.
//
// Only real deaths (Step 2) decrement the counters, so a teammate who
// dies and gets revived still counts as standing — you were never truly
// the last one alive if someone came back up.
//
// Returns null when no clutch occurred, otherwise:
//   clutchType              how many enemies were alive at the trigger (1-5)
//   clutchStartMs           when the last teammate permanently died
//   killsAfterClutch        kills the player got from that point on
//   killTimes               timestamps of those kills
//   enemyAliveAfterLastKill enemies left standing after the final kill
//   deathMs                 when the player died, or null if they survived
function detectClutch(roundKills,realDeath,pTeam,puuid,startMyAlive=5,startEnemyAlive=5){
  let myAlive=startMyAlive,enemyAlive=startEnemyAlive,meAlive=true;
  let clutchType=null,clutchStartMs=null,deathMs=null;
  let killsAfterClutch=0,killTimes=[],enemyAliveAfterLastKill=null;

  for(const k of roundKills){
    const victim=k.victim?.puuid;
    const killMs=k.time_in_round_in_ms??0;

    if(victim&&realDeath[victim]===killMs){
      const victimTeam=k.victim?.team?.toLowerCase();
      if(victimTeam===pTeam)myAlive--;else if(victimTeam)enemyAlive--;

      // The tracked player's own death ends their round — stop here so
      // nothing after it counts toward them.
      if(victim===puuid){meAlive=false;deathMs=killMs;break;}

      // Last teammate down, player still up → clutch begins. Latched on
      // first trigger only; myAlive only ever counts down, so it can
      // pass through 1 exactly once per round.
      if(meAlive&&myAlive===1&&clutchType==null){
        clutchType=enemyAlive;
        clutchStartMs=killMs;
      }
    }

    // Kills the player lands once the clutch is underway. Self-kills
    // (walking into your own utility) don't count as progress.
    const isSelfKill=k.killer?.puuid===victim;
    if(clutchType!=null&&k.killer?.puuid===puuid&&!isSelfKill){
      killsAfterClutch++;
      enemyAliveAfterLastKill=enemyAlive;
      killTimes.push(killMs);
    }
  }

  // clutchType is the enemy count at trigger time. 0 means the enemy team
  // was already wiped, which isn't a clutch — the round was already won.
  if(clutchType==null||clutchType<1||clutchType>5)return null;
  return{clutchType,clutchStartMs,killsAfterClutch,killTimes,enemyAliveAfterLastKill,deathMs};
}

/* ── Exports ──────────────────────────────────────────────────────────────
   ES-module by default. For CommonJS (Node require) or a browser <script>,
   delete this block — the four functions and the constants above are already
   declared at module scope and are all you need. */
export {
  presentCount,
  computeRealDeaths,
  detectClutch,
  // tunable constants (documented inline above)
  REVIVE_MIN_GAP_MS,
  CLOVE_REVIVE_SPIKE_BOUNDARY_MS,
  CLOVE_REVIVE_ROUND_BOUNDARY_MS,
  MAX_CLOVE_SELF_REVIVE_WINDOW_MS,
  POST_ROUND_PHASE_MS,
};
