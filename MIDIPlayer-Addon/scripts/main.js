import {  world, system, Player, CustomCommandParamType, CommandPermissionLevel } from '@minecraft/server';
import { http,HttpRequest, HttpRequestMethod } from '@minecraft/server-net';

const SERVER_URL = 'http://localhost:3000';
const playerPlaybackTasks = new Map();

system.beforeEvents.startup.subscribe(ev => {
    ev.customCommandRegistry.registerCommand({
        name: "midiplayer:playmidi",
        description: "MIDIファイルを再生します。",
        permissionLevel: CommandPermissionLevel.Any,
        optionalParameters: [
            { name: "subcommand", type: CustomCommandParamType.String },
            { name: "filename", type: CustomCommandParamType.String, optional: true },
            { name: "option1", type: CustomCommandParamType.String, optional: true },
            { name: "option2", type: CustomCommandParamType.String, optional: true },
            { name: "option3", type: CustomCommandParamType.String, optional: true },
            { name: "option4", type: CustomCommandParamType.String, optional: true },
        ]
    }, (origin, ...args) => {
        handlePlayMidiCommand(origin.sourceEntity, args);
    });
});


/**
 * playmidiコマンドのメイン処理
 * @param {Player} sender
 * @param {string[]} args
 */
async function handlePlayMidiCommand(sender, args) {
    if (!sender || !(sender instanceof Player)) {
        console.warn("このコマンドはプレイヤーからのみ実行できます。");
        return;
    }

    const [subcommand, fileName, ...optionsArgs] = args.filter(Boolean);

    if (!subcommand || subcommand === 'help' || subcommand === 'ヘルプ') {
        sender.sendMessage("§e--- MIDIプレイヤー コマンドヘルプ ---");
        sender.sendMessage("§a/playmidi play <ファイル名.mid> [オプション]");
        sender.sendMessage("§7  MIDIファイルを再生します。");
        sender.sendMessage("§bオプション:");
        sender.sendMessage("§7  poly:<数値>   §f- 1ティックあたりの最大同時発音数を設定 (例: poly:16)");
        sender.sendMessage("§7  vol:<数値>    §f- 全体の音量を設定 (0.0 ~ 2.0, 例: vol:0.8)");
        sender.sendMessage("§7  minvol:<数値> §f- ノートの最小音量を設定 (例: minvol:0.1)");
        sender.sendMessage("§7  legacy        §f- [非推奨] 古い再生互換モードを使用");
        sender.sendMessage("§7  simple        §f- 楽器を無視したシンプルな再生モードを使用(めっちゃおすすめ！！)");
        sender.sendMessage("§e------------------------------------");
        return;
    }

    if (subcommand !== 'play' || !fileName) {
        sender.sendMessage("§cコマンドの形式が正しくありません。/mc:playmidi help を参照してください。");
        return;
    }

    try {
        const playOptions = parsePlayMidiOptions(fileName, optionsArgs);

        if (playOptions.simple) {
            await executeSimplePlayback(sender, playOptions);
        } else {
            await executeAdvancedPlayback(sender, playOptions);
        }

    } catch (error) {
        sender.sendMessage(`§cリクエスト中にエラーが発生しました。`);
        console.error(JSON.stringify(error, null, 2));
    }
}

/**
 * シンプル再生モードを実行
 * @param {Player} sender
 * @param {object} playOptions
 */
async function executeSimplePlayback(sender, playOptions) {
    sender.sendMessage(`§aシンプルモードで [${playOptions.fileName}] を取得中...`);
    const url = `${SERVER_URL}/midi-simple?file=${encodeURIComponent(playOptions.fileName)}`;
    const request = new HttpRequest(url);
    request.method = HttpRequestMethod.Get;
    request.timeout = 30;

    const response = await http.request(request);
    if (response.status !== 200) {
        sender.sendMessage(`§cサーバーエラー: ${response.status} - ${response.body}`);
        return;
    }

    const sequence = JSON.parse(response.body);
    if (!sequence || sequence.length === 0) {
        sender.sendMessage("§c再生するノートが見つかりませんでした。");
        return;
    }

    sender.sendMessage(`§a${sequence.length}件のノートを読み込みました。シンプル再生を開始します...`);
    playSimpleSequence(sequence, sender, playOptions.globalVolume);
}

/**
 * 高度な再生モードを実行
 * @param {Player} sender
 * @param {object} playOptions
 */
async function executeAdvancedPlayback(sender, playOptions) {
    sender.sendMessage(`§aアドバンスモードで [${playOptions.fileName}] を取得中...`);
    let url = `${SERVER_URL}/midi-sequence?file=${encodeURIComponent(playOptions.fileName)}&polyphony=${playOptions.polyphony}`;
    if (playOptions.legacy) {
        url += '&legacy=true';
        sender.sendMessage("§e(レガシー再生モードが有効です)");
    }

    const request = new HttpRequest(url);
    request.method = HttpRequestMethod.Get;
    request.timeout = 30;

    const response = await http.request(request);
    if (response.status !== 200) {
        sender.sendMessage(`§cサーバーエラー: ${response.status} - ${response.body}`);
        return;
    }

    const sequence = JSON.parse(response.body);
    if (!sequence || sequence.length === 0) {
        sender.sendMessage("§c再生するサウンドイベントが見つかりませんでした。");
        return;
    }

    sender.sendMessage(`§a${sequence.length}件のコマンドを読み込みました。アドバンス再生を開始します...`);
    playAdvancedSequence(sequence, sender, playOptions);
}


/**
 * コマンドのオプション引数を解析
 * @param {string} fileName
 * @param {string[]} args
 * @returns {object}
 */
function parsePlayMidiOptions(fileName, args) {
    const options = {
        fileName: fileName,
        polyphony: 8,
        globalVolume: 1.0,
        minVolume: 0.15,
        legacy: args.includes('legacy'),
        simple: args.includes('simple'),
    };

    args.forEach(arg => {
        if (arg.startsWith('poly:')) options.polyphony = parseInt(arg.split(':')[1]) || 8;
        if (arg.startsWith('vol:')) options.globalVolume = parseFloat(arg.split(':')[1]) || 1.0;
        if (arg.startsWith('minvol:')) options.minVolume = parseFloat(arg.split(':')[1]) || 0.15;
    });

    return options;
}

/**
 * [SIMPLE MODE] シンプルな再生ロジック
 * @param {Array<object>} sequence
 * @param {Player} player
 * @param {number} globalVolume
 */
function playSimpleSequence(sequence, player, globalVolume) {
    if (playerPlaybackTasks.has(player.id)) {
        system.clearRun(playerPlaybackTasks.get(player.id));
        player.sendMessage("§e以前の再生を停止しました。");
    }

    let sequenceIndex = 0;
    let currentTick = 0;
    const maxTick = sequence.length > 0 ? sequence[sequence.length - 1].tick : -1;
    if (maxTick < 0) return;

    const playerLocation = player.location;

    const runId = system.runInterval(() => {
        try {
            if (!player.isValid || currentTick > maxTick) {
                system.clearRun(runId);
                playerPlaybackTasks.delete(player.id);
                if (player.isValid) player.sendMessage("§aシンプル再生が完了しました。");
                return;
            }

            while (sequenceIndex < sequence.length && sequence[sequenceIndex].tick === currentTick) {
                const event = sequence[sequenceIndex];

                player.dimension.playSound("note.harp", playerLocation, {
                    pitch: 2 ** ((event.pitch - 12) / 12.0),
                    volume: (event.velocity || 0.8) * globalVolume
                });

                sequenceIndex++;
            }

            currentTick++;
        } catch (e) {
            console.error("シンプル再生中の致命的なエラー:", JSON.stringify(e, null, 2));
            system.clearRun(runId);
            playerPlaybackTasks.delete(player.id);
        }
    }, 1);

    playerPlaybackTasks.set(player.id, runId);
}

/**
 * [ADVANCED MODE] 高度な再生ロジック
 * @param {Array<object>} sequence
 * @param {Player} player
 * @param {object} playOptions
 */
function playAdvancedSequence(sequence, player, playOptions) {
    if (playerPlaybackTasks.has(player.id)) {
        system.clearRun(playerPlaybackTasks.get(player.id));
        player.sendMessage("§e以前の再生を停止しました。");
    }

    let sequenceIndex = 0;
    let currentTick = 0;
    const maxTick = sequence.length > 0 ? sequence[sequence.length - 1].tick : -1;
    if (maxTick < 0) return;

    const playerLocation = player.location;
    const viewDirection = player.getViewDirection();

    const rightVector = { x: viewDirection.z, y: 0, z: -viewDirection.x };
    const magnitude = Math.sqrt(rightVector.x ** 2 + rightVector.z ** 2);
    if (magnitude > 0) {
        rightVector.x /= magnitude;
        rightVector.z /= magnitude;
    }

    const instrumentSoundMap = {
        'planks': 'harp', 'stone': 'bassdrum', 'sand': 'snare', 'glass': 'hat',
        'gold_block': 'bell', 'clay': 'flute', 'packed_ice': 'chime',
        'bone_block': 'xylophone', 'iron_block': 'iron_xylophone', 'pumpkin': 'didgeridoo',
        'emerald_block': 'bit', 'hay_block': 'banjo', 'glowstone': 'pling',
    };

    const runId = system.runInterval(() => {
        try {
            if (!player.isValid || currentTick > maxTick) {
                system.clearRun(runId);
                playerPlaybackTasks.delete(player.id);
                if (player.isValid) player.sendMessage("§aアドバンス再生が完了しました。");
                return;
            }

            const notesToPlayThisTick = [];
            while (sequenceIndex < sequence.length && sequence[sequenceIndex].tick === currentTick) {
                notesToPlayThisTick.push(sequence[sequenceIndex]);
                sequenceIndex++;
            }

            if (notesToPlayThisTick.length > 0) {
                system.run(() => {
                    if (!player.isValid) return;

                    for (const event of notesToPlayThisTick) {
                        try {
                            const instrumentSound = instrumentSoundMap[event.instrument] || 'harp';
                            const soundId = `note.${instrumentSound}`;

                            const basePitch = (event.pitch || 60) - 54;
                            const pitchBendOffset = (event.pitchBend || 0) * 2.0;
                            const finalPitch = 2 ** ((basePitch + pitchBendOffset - 12) / 12.0);

                            let volume = ((event.velocity || 0.75) + (event.volume - 1.0)) * playOptions.globalVolume;
                            volume = Math.max(volume, playOptions.minVolume);
                            volume = Math.min(volume, 2.0);

                            const pan = event.pan || 0.5;
                            const panOffset = (pan - 0.5) * 10.0;
                            const soundLocation = {
                                x: playerLocation.x + rightVector.x * panOffset,
                                y: playerLocation.y,
                                z: playerLocation.z + rightVector.z * panOffset
                            };

                            if (volume > 0 && isFinite(finalPitch) && isFinite(soundLocation.x)) {
                                player.dimension.playSound(soundId, soundLocation, { pitch: finalPitch, volume });
                            }
                        } catch (innerError) {
                            console.error(`ノート再生エラー:`, JSON.stringify(innerError, null, 2));
                        }
                    }
                });
            }
            currentTick++;
        } catch (e) {
            console.error("再生ループ中の致命的なエラー:", JSON.stringify(e, null, 2));
            system.clearRun(runId);
            playerPlaybackTasks.delete(player.id);
        }
    }, 1);

    playerPlaybackTasks.set(player.id, runId);
}

world.afterEvents.playerLeave.subscribe(ev => {
    const { playerId } = ev;
    if (playerPlaybackTasks.has(playerId)) {
        system.clearRun(playerPlaybackTasks.get(playerId));
        playerPlaybackTasks.delete(playerId);
        console.log(`退出したプレイヤーの再生タスクをクリアしました: ${playerId}`);
    }
});