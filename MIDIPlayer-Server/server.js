const express = require('express');
const cors = require('cors');
const fs = require('fs');
const { Midi } = require('@tonejs/midi');

const app = express();
const port = 3000;
app.use(cors());
app.use(express.json());

const instrumentMap = {
    default: 'planks', piano: 'planks', acoustic_bass: 'planks', electric_bass_finger: 'planks',
    electric_bass_pick: 'planks', acoustic_guitar_nylon: 'planks', acoustic_guitar_steel: 'planks',
    electric_guitar_clean: 'planks', xylophone: 'bone_block', tubular_bells: 'iron_block',
    flute: 'clay', bell: 'gold_block', chime: 'packed_ice', didgeridoo: 'pumpkin',
    synth_bass_1: 'emerald_block', banjo: 'hay_block', glockenspiel: 'glowstone',
    35: 'stone', 36: 'stone', 38: 'sand', 40: 'sand', 42: 'glass', 46: 'glass', 49: 'glass',
};

/**
 * [LEGACY] ノートを後続ティックにずらす関数
 * @param {Array<object>} notes - オリジナルのノート配列
 * @param {number} maxPolyphony - 1ティックに許容する最大同時発音数
 * @param {number} maxShiftTicks - ノートをずらす最大ティック数
 * @returns {Array<object>} - 再スケジュールされたノート配列
 */
function rescheduleNotesForClarity(notes, maxPolyphony = 5, maxShiftTicks = 2) {
    if (!notes || notes.length === 0) return [];
    console.log(`[LEGACY] Rescheduling notes with max polyphony ${maxPolyphony} and max shift ${maxShiftTicks}...`);
    
    const notesSortedByVelocity = JSON.parse(JSON.stringify(notes)).sort((a, b) => b.velocity - a.velocity);
    const tickOccupancy = new Map();
    const rescheduledNotes = [];

    for (const note of notesSortedByVelocity) {
        let currentTick = note.tick;
        let placed = false;
        for (let i = 0; i <= maxShiftTicks; i++) {
            const checkTick = note.tick + i;
            if ((tickOccupancy.get(checkTick) || 0) < maxPolyphony) {
                currentTick = checkTick;
                placed = true;
                break;
            }
        }
        if (!placed) continue;
        note.tick = currentTick;
        rescheduledNotes.push(note);
        const count = (tickOccupancy.get(currentTick) || 0) + 1;
        tickOccupancy.set(currentTick, count);
    }
    
    rescheduledNotes.sort((a, b) => a.tick - b.tick);
    console.log(`[LEGACY] Rescheduling complete. Original notes: ${notes.length}, Final notes: ${rescheduledNotes.length}`);
    return rescheduledNotes;
}

/**
 * [DEFAULT] 高度なシーケンス生成
 * @param {string} filePath - MIDIファイルへのパス
 * @param {number} maxPolyphony - 1ティックあたりの最大同時発音数
 * @returns {Promise<Array<object>>} - サウンドイベントの配列
 */
async function createOptimizedSoundSequence(filePath, maxPolyphony) {
    if (!fs.existsSync(filePath)) throw new Error('MIDI file not found');
    const midi = new Midi(fs.readFileSync(filePath));
    const soundEvents = [];
    const trackStates = new Map();
    midi.tracks.forEach((track, trackIndex) => {
        trackStates.set(trackIndex, { volume: 1.0, sustain: false, pitchBend: 0, pan: 0.5, heldNotes: new Map() });
        track.notes.forEach(note => {
            const isPercussion = track.channel === 9;
            const instrumentName = isPercussion ? 'percussion' : track.instrument.name;
            let instrumentBlock = instrumentMap[instrumentName] || instrumentMap.default;
            if (isPercussion && instrumentMap[note.midi]) instrumentBlock = instrumentMap[note.midi];
            soundEvents.push({ time: note.time, type: 'note_on', track: trackIndex, note: { ...note, instrument: instrumentBlock } });
            soundEvents.push({ time: note.time + note.duration, type: 'note_off', track: trackIndex, note: { pitch: note.midi } });
        });
        if (track.controlChanges && typeof track.controlChanges === 'object') {
            const allControlEvents = Object.values(track.controlChanges).flat();
            allControlEvents.forEach(cc => soundEvents.push({ time: cc.time, type: 'control_change', track: trackIndex, control: { number: cc.number, value: cc.value / 127.0 } }));
        }
        track.pitchBends.forEach(pb => soundEvents.push({ time: pb.time, type: 'pitch_bend', track: trackIndex, value: pb.value }));
    });
    soundEvents.sort((a, b) => a.time - b.time);
    const scheduledNotes = {};
    const activeNotes = new Map();
    for (const event of soundEvents) {
        const state = trackStates.get(event.track);
        if (!state) continue;
        const tick = Math.round(event.time * 20);
        if (!scheduledNotes[tick]) scheduledNotes[tick] = [];
        switch (event.type) {
            case 'note_on': activeNotes.set(`${event.track}-${event.note.midi}`, { ...event.note, state: { ...state } }); break;
            case 'note_off': if (state.sustain) { state.heldNotes.set(event.note.pitch, true); } else { activeNotes.delete(`${event.track}-${event.note.pitch}`); } break;
            case 'control_change':
                switch (event.control.number) {
                    case 7: state.volume = event.control.value; break;
                    case 10: state.pan = event.control.value; break;
                    case 64:
                        const newSustain = event.control.value > 0.5;
                        if (state.sustain && !newSustain) {
                            state.heldNotes.forEach((_, pitch) => { activeNotes.delete(`${event.track}-${pitch}`); });
                            state.heldNotes.clear();
                        }
                        state.sustain = newSustain;
                        break;
                }
                break;
            case 'pitch_bend': state.pitchBend = event.value; break;
        }
        scheduledNotes[tick] = Array.from(activeNotes.values());
    }
    const finalPlaybackCommands = [];
    for (const tickStr in scheduledNotes) {
        const tick = parseInt(tickStr);
        let notesForTick = scheduledNotes[tick];
        if (notesForTick.length > maxPolyphony) {
            notesForTick.sort((a, b) => (b.velocity * 5 + Math.min(40, (b.duration * 20))) - (a.velocity * 5 + Math.min(40, (a.duration * 20))));
            notesForTick = notesForTick.slice(0, maxPolyphony);
        }
        notesForTick.forEach(note => finalPlaybackCommands.push({ tick, instrument: note.instrument, pitch: note.midi, velocity: note.velocity, pan: note.state.pan, volume: note.state.volume, pitchBend: note.state.pitchBend, }));
    }
    return finalPlaybackCommands;
}

/**
 * [SIMPLE MODE] MIDIから基本的なノート情報だけを抽出する軽量な関数
 * @param {string} filePath - MIDIファイルへのパス
 * @returns {Promise<Array<object>>} - tick, pitch, velocity を持つノートオブジェクトの配列
 */
async function convertMidiToSimpleNotes(filePath) {
    if (!fs.existsSync(filePath)) throw new Error('MIDI file not found');
    const midiData = fs.readFileSync(filePath);
    const midi = new Midi(midiData);
    const notes = [];
    midi.tracks.forEach((track) => {
        track.notes.forEach(note => {
            const tick = Math.round(note.time * 20);
            let pitch = note.midi - 54;
            while (pitch < 0) pitch += 12;
            while (pitch > 24) pitch -= 12;
            notes.push({ tick, pitch, velocity: note.velocity });
        });
    });
    notes.sort((a, b) => a.tick - b.tick);
    return notes;
}

// APIエンドポイント: 高度な再生用
app.get('/midi-sequence', async (req, res) => {
    const { file, polyphony, legacy } = req.query;
    if (!file) return res.status(400).send({ error: '"file" is required.' });
    try {
        const maxPolyphonyNum = polyphony !== undefined ? parseInt(polyphony) : 8;
        const sequence = await createOptimizedSoundSequence(`./midi/${file}`, maxPolyphonyNum);
        if (legacy === 'true') {
            const rescheduledSequence = rescheduleNotesForClarity(sequence, 5, 2);
            res.json(rescheduledSequence);
        } else {
            res.json(sequence);
        }
    } catch (error) {
        console.error(`Error processing advanced sequence for ${file}:`, error);
        res.status(500).send({ error: error.message });
    }
});

// APIエンドポイント: シンプル再生用
app.get('/midi-simple', async (req, res) => {
    const { file } = req.query;
    if (!file) return res.status(400).send({ error: '"file" is required.' });
    try {
        const filePath = `./midi/${file}`;
        const simpleNotes = await convertMidiToSimpleNotes(filePath);
        res.json(simpleNotes);
    } catch (error) {
        console.error(`Error processing simple for ${file}:`, error);
        res.status(500).send({ error: error.message });
    }
});

app.listen(port, () => console.log(`MIDI Server (Simple/Advanced/Legacy modes) listening at http://localhost:${port}`));