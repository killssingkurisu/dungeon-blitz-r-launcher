'use strict';

const { EventEmitter } = require('events');
const P = require('./protocol');

/**
 * Follows one game connection and turns its packets into the player's casts and damage. It only
 * reads packets (fromClient for the client's, fromServer for the server's), wherever they come
 * from: the DB DPS Launcher's relay, or a server's combat feed.
 *
 * Entity ids are the client's own numbering on both directions of one connection (the server
 * translates for each viewer), so everything is kept per connection. The player's body is the
 * entity the client reports with isPlayer set (0x08); its summons are the entities the client
 * reports with that body (or another of its summons) as summoner.
 */
class CombatTracker extends EventEmitter {
    constructor(label) {
        super();
        this.label = label;
        this.ownId = 0;
        this.characterName = '';
        this.summons = new Map(); // id -> { name, powerId }
        this.entities = new Map(); // id -> { name, isPlayer, team }
        this.recentDots = []; // [at, targetId, powerId, amount] sent by this client, to skip echoes
        this.packets = { up: 0, down: 0 };
        this.dummyTicksKept = 0;
        this.states = new Map(); // id -> last entState seen (dead = P.ENT_STATE.DEAD)
        this.isBoss = () => false; // set by the meter: EntName -> whether it's a Boss
    }

    /**
     * An entity's state from a 0x07 or 0x08, either way: the client sends them for what it runs
     * (its own body, its mobs when it is the one running them), the server forwards the rest.
     * Only a change counts, so a corpse seen for the first time is not a death:
     *   'died' / 'revived' for the player's own body; 'bossDied' when a Boss dies.
     */
    noteState(id, state) {
        if (!id) return;
        const before = this.states.get(id);
        this.states.set(id, state);
        if (before === undefined || before === state) return;
        const dead = state === P.ENT_STATE.DEAD;
        const wasDead = before === P.ENT_STATE.DEAD;
        if (dead === wasDead) return;
        if (id === this.ownId) {
            this.emit(dead ? 'died' : 'revived');
            return;
        }
        const e = this.entities.get(id);
        if (dead && e && !e.isPlayer && !this.summons.has(id) && this.isBoss(e.name)) {
            this.emit('bossDied', { id, name: e.name });
        }
    }

    /** Dungeon progress, from either direction: 'completion' (percent), 'levelComplete'. */
    noteLevel(id, payload, from) {
        if (id === P.PKT.LEVEL_COMPLETION) {
            this.emit('completion', P.parseLevelCompletion(payload).percent);
        } else if (id === P.PKT.SET_LEVEL_COMPLETE || id === P.PKT.RECV_LEVEL_COMPLETE) {
            this.emit('levelComplete', { from });
        }
    }

    isOwnSource(id) {
        return id !== 0 && (id === this.ownId || this.summons.has(id));
    }

    isFriendlyTarget(id) {
        if (id === this.ownId || this.summons.has(id)) {
            return true;
        }
        const e = this.entities.get(id);
        return Boolean(e && (e.isPlayer || e.team === P.TEAM.PLAYER));
    }

    targetName(id) {
        const e = this.entities.get(id);
        return e ? e.name : '';
    }

    /** Reads one packet from the client. Returns 'drop' for a packet that must not reach the server. */
    fromClient(id, payload) {
        this.packets.up += 1;
        switch (id) {
            case P.PKT.ENT_FULL_UPDATE: {
                const e = P.parseEntityFullUpdate(payload);
                this.entities.set(e.id, { name: e.name, isPlayer: e.isPlayer, team: e.team });
                if (e.isPlayer) {
                    if (this.ownId !== e.id || this.characterName !== e.name) {
                        this.ownId = e.id;
                        this.characterName = e.name;
                        this.emit('character', { id: e.id, name: e.name });
                    }
                } else if (e.summonerId && this.isOwnSource(e.summonerId)) {
                    this.summons.set(e.id, { name: e.name, powerId: e.powerId });
                }
                this.noteState(e.id, e.entState);
                break;
            }
            case P.PKT.ENT_INCREMENTAL_UPDATE: {
                const u = P.parseIncrementalUpdate(payload);
                this.noteState(u.id, u.entState);
                break;
            }
            case P.PKT.LEVEL_COMPLETION:
            case P.PKT.SET_LEVEL_COMPLETE:
                this.noteLevel(id, payload, 'client');
                break;
            case P.PKT.POWER_CAST: {
                const c = P.parsePowerCast(payload);
                if (c.sourceId && c.sourceId === this.ownId) {
                    this.emit('cast', { powerId: c.powerId, combo: c.combo, projectile: c.projectileId !== null });
                }
                break;
            }
            case P.PKT.POWER_HIT: {
                const h = P.parsePowerHit(payload);
                if (h.damage > 0 && this.isOwnSource(h.sourceId) && !this.isFriendlyTarget(h.targetId)) {
                    const ev = this.damageEvent('hit', h.sourceId, h.powerId, h.damage, h.isCrit, h.targetId);
                    // A proc's hit (Charon's Blades' ProcCriticalHit, a glancing blow) names the power
                    // that set it off in its first optional id: ActivePower.var_249, written by
                    // LinkUpdater.method_1092. See DpsMeter.resolve.
                    if (h.animOverrideId && h.animOverrideId !== h.powerId) ev.originId = h.animOverrideId;
                    this.emit('damage', ev);
                } else if (!h.damage && h.animOverrideId && h.animOverrideId !== h.powerId && this.ownId && h.sourceId === this.ownId && !this.isFriendlyTarget(h.targetId)) {
                    // A proc that deals no damage itself, landing: Hemorrhage puts its bleed on the
                    // target this way, sized by the hit that set it off (the power named here).
                    this.emit('procApplied', { powerId: h.powerId, originId: h.animOverrideId, targetId: h.targetId, targetName: this.targetName(h.targetId) });
                }
                break;
            }
            case P.PKT.BUFF_TICK_DOT: {
                const d = P.parseBuffTickDot(payload);
                if (d.amount !== 0 && this.isOwnSource(d.sourceId) && !this.isFriendlyTarget(d.targetId)) {
                    const now = Date.now();
                    this.recentDots.push([now, d.targetId, d.powerId, Math.abs(d.amount)]);
                    if (this.recentDots.length > 64) this.recentDots.shift();
                    this.emit('damage', this.damageEvent('dot', d.sourceId, d.powerId, Math.abs(d.amount), false, d.targetId));
                }
                // An unmodified client never sends ticks on a training dummy. The DB DPS Launcher's
                // copy of the game does, so its meter can count them, and 'drop' tells its relay to
                // keep them from the server. Fed packets any other way, the verdict is ignored.
                if (this.isDummy(d.targetId)) {
                    this.dummyTicksKept += 1;
                    return 'drop';
                }
                break;
            }
            default:
                break;
        }
        return undefined;
    }

    /** The house training dummies (behaviour HomeDummy: entity types HomeDummy1-3). */
    isDummy(id) {
        const e = this.entities.get(id);
        return Boolean(e && /^HomeDummy/.test(e.name));
    }

    fromServer(id, payload) {
        this.packets.down += 1;
        switch (id) {
            case P.PKT.NEWLY_RELEVANT_ENTITY: {
                const e = P.parseNewlyRelevantEntity(payload);
                this.entities.set(e.id, { name: e.name, isPlayer: e.isPlayer, team: e.team });
                this.states.delete(e.id); // a new entity, or one back in view: nothing known yet
                break;
            }
            case P.PKT.ENT_INCREMENTAL_UPDATE: {
                const u = P.parseIncrementalUpdate(payload);
                this.noteState(u.id, u.entState);
                break;
            }
            case P.PKT.LEVEL_COMPLETION:
            case P.PKT.RECV_LEVEL_COMPLETE:
                this.noteLevel(id, payload, 'server');
                break;
            case P.PKT.ENTER_WORLD: {
                this.emit('enterWorld', P.parseEnterWorld(payload));
                break;
            }
            case P.PKT.RECEIVE_GOLD: {
                // Gold the server gave you: a pile you picked up, a reward.
                const g = P.parseReceiveGold(payload);
                if (g.amount > 0) this.emit('gold', g.amount);
                break;
            }
            case P.PKT.BUFF_TICK_DOT: {
                // A DoT of ours ticking on a mob another party member's client runs comes back
                // from the server instead of going out from ours.
                const d = P.parseBuffTickDot(payload);
                const amount = Math.abs(d.amount);
                if (!amount || !this.isOwnSource(d.sourceId) || this.isFriendlyTarget(d.targetId)) {
                    break;
                }
                const now = Date.now();
                const echo = this.recentDots.findIndex(
                    (r) => now - r[0] < 1500 && r[1] === d.targetId && r[2] === d.powerId && r[3] === amount
                );
                if (echo >= 0) {
                    this.recentDots.splice(echo, 1);
                    break;
                }
                this.emit('damage', this.damageEvent('dot', d.sourceId, d.powerId, amount, false, d.targetId));
                break;
            }
            default:
                break;
        }
    }

    damageEvent(kind, sourceId, powerId, damage, crit, targetId) {
        const summon = sourceId !== this.ownId ? this.summons.get(sourceId) || null : null;
        return {
            kind,
            powerId: summon && !powerId ? summon.powerId : powerId,
            damage,
            crit: Boolean(crit),
            targetId,
            targetName: this.targetName(targetId),
            summon
        };
    }
}

module.exports = { CombatTracker };
