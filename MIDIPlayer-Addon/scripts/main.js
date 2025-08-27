import { world, system, Player, CustomCommandParamType, CommandPermissionLevel } from '@minecraft/server';
import { http, HttpRequest, HttpRequestMethod } from '@minecraft/server-net';

const SERVER_URL = 'http://localhost:3000';
const playerPlaybackTasks = new Map();

system.beforeEvents.startup.subscribe(ev => {
    ev.customCommandRegistry.registerCommand({
        name: "midiplayer:playmidi",
        description: "MIDIファイルを再生します。",
        permissionLevel: CommandPermissionLevel.Any,
        optionalParameters: [
            { name: "subcommand", type: CustomCommandParamType.String },
            { name: "filename_or_option1", type: CustomCommandParamType.String, optional: true },
            { name: "option2", type: CustomCommandParamType.String, optional: true },
            { name: "option3", type: CustomCommandParamType.String, optional: true },
            { name: "option4", type: CustomCommandParamType.String, optional: true },
            { name: "option5", type: CustomCommandParamType.String, optional: true },
            { name: "option6", type: CustomCommandParamType.String, optional: true },
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

    const [subcommand, ...commandArgs] = args.filter(Boolean);

    if (!subcommand || subcommand === 'help' || subcommand === 'ヘルプ') {
        sender.sendMessage("§e--- MIDIプレイヤー コマンドヘルプ ---");
        sender.sendMessage("§a/playmidi play <ファイル名> [オプション] §7- 曲を再生");
        sender.sendMessage("§a/playmidi random [オプション] §7- ランダムな曲を再生");
        sender.sendMessage("§a/playmidi stop §7- 現在の曲を停止");
        sender.sendMessage("§bオプション:");
        sender.sendMessage("§7  stationary    §f- 音をコマンド実行地点に固定します (BGMモードOFF)");
        sender.sendMessage("§7  loop          §f- 曲をループ再生します");
        sender.sendMessage("§7  simple        §f- シンプルモードで再生 (めっちゃおすすめ！！)");
        sender.sendMessage("§7  poly:<数値>   §f- 最大同時発音数を設定 (例: poly:16)");
        sender.sendMessage("§7  vol:<数値>    §f- 全体の音量を設定 (0.0 ~ 2.0, 例: vol:0.8)");
        sender.sendMessage("§7  minvol:<数値> §f- ノートの最小音量を設定 (例: minvol:0.1)");
        sender.sendMessage("§7  legacy        §f- [非推奨] 古い再生互換モードを使用");
        sender.sendMessage("§e------------------------------------");
        return;
    }
    
    if (subcommand === 'stop') {
        if (playerPlaybackTasks.has(sender.id)) {
            system.clearRun(playerPlaybackTasks.get(sender.id).runId);
            playerPlaybackTasks.delete(sender.id);
            sender.sendMessage("§a再生を停止しました。");
        } else {
            sender.sendMessage("§e現在再生中の曲はありません。");
        }
        return;
    }
    
    if (subcommand === 'play' || subcommand === 'random') {
        let fileName;
        let options;

        if (subcommand === 'play') {
            if (commandArgs.length < 1) {
                sender.sendMessage("§cファイル名を指定してください。/playmidi help を参照してください。");
                return;
            }
            fileName = commandArgs[0];
            options = commandArgs.slice(1);
        } else {
            fileName = 'random';
            options = commandArgs;
        }

        try {
            const playOptions = parsePlayMidiOptions(fileName, options);
            if (playerPlaybackTasks.has(sender.id)) {
                system.clearRun(playerPlaybackTasks.get(sender.id).runId);
                playerPlaybackTasks.delete(sender.id);
            }
            executePlayback(sender, playOptions);
        } catch (error) {
            sender.sendMessage(`§cコマンド処理中にエラーが発生しました。`);
            console.error(JSON.stringify(error, null, 2));
        }
    } else {
        sender.sendMessage("§c無効なサブコマンドです。/playmidi help を参照してください。");
    }
}

/**
 * 共通の再生実行関数 (ループとランダムループに対応)
 * @param {Player} sender
 * @param {object} playOptions
 */
async function executePlayback(sender, playOptions) {
    if (!sender.isValid) {
        if (playerPlaybackTasks.has(sender.id)) {
            system.clearRun(playerPlaybackTasks.get(sender.id).runId);
            playerPlaybackTasks.delete(sender.id);
        }
        return;
    }

    const modeText = playOptions.simple ? "シンプル" : "アドバンス";
    const isRandom = playOptions.originalFileName === 'random';
    const fileNameText = isRandom ? "ランダムな曲" : `[${playOptions.fileName}]`;

    if (!playOptions.isLooping) {
        sender.sendMessage(`§a${modeText}モードで ${fileNameText} を取得中...`);
    }

    const endpoint = playOptions.simple ? '/midi-simple' : '/midi-sequence';
    let url = `${SERVER_URL}${endpoint}?file=${encodeURIComponent(playOptions.fileName)}`;
    
    if (!playOptions.simple) {
        url += `&polyphony=${playOptions.polyphony}`;
        if (playOptions.legacy) {
            url += '&legacy=true';
            if (!playOptions.isLooping) sender.sendMessage("§e(レガシー再生モードが有効です)");
        }
    }

    try {
        const request = new HttpRequest(url);
        request.method = HttpRequestMethod.Get;
        request.timeout = 30;

        const response = await http.request(request);
        if (response.status !== 200) {
            sender.sendMessage(`§cサーバーエラー: ${response.status} - ${response.body}`);
            if (playOptions.loop) sender.sendMessage("§eループ再生を停止しました。");
            return;
        }

        const sequenceData = JSON.parse(response.body);
        const sequence = sequenceData.sequence;
        playOptions.fileName = sequenceData.fileName;

        if (!sequence || sequence.length === 0) {
            sender.sendMessage("§c再生するノートが見つかりませんでした。");
            if (playOptions.loop) sender.sendMessage("§eループ再生を停止しました。");
            return;
        }
        
        if (isRandom) {
            sender.sendMessage(`§b再生中の曲: ${sequenceData.fileName}`);
        }
        if (!playOptions.isLooping) {
            sender.sendMessage(`§a${sequence.length}件のイベントを読み込みました。再生を開始します...`);
        }

        const playbackFunction = playOptions.simple ? playSimpleSequence : playAdvancedSequence;
        
        await new Promise(resolve => {
            playbackFunction(sequence, sender, playOptions, resolve);
        });

        if (playOptions.loop && playerPlaybackTasks.has(sender.id)) {
            if (isRandom) {
                playOptions.fileName = 'random';
            }
            playOptions.isLooping = true;
            executePlayback(sender, playOptions);
        }

    } catch (error) {
        sender.sendMessage(`§cリクエスト中にエラーが発生しました。`);
        if (playOptions.loop) sender.sendMessage("§eループ再生を停止しました。");
        console.error(JSON.stringify(error, null, 2));
    }
}


/**
 * コマンドのオプション引数を解析
 * @param {string} fileName
 * @param {string[]} args
 * @returns {object}
 */
function parsePlayMidiOptions(fileName, args) {
    const options = {
        originalFileName: fileName,
        fileName: fileName,
        polyphony: 8,
        globalVolume: 1.0,
        minVolume: 0.15,
        legacy: args.includes('legacy'),
        simple: args.includes('simple'),
        loop: args.includes('loop'),
        stationary: args.includes('stationary'),
        isLooping: false,
    };

    args.forEach(arg => {
        if (arg.startsWith('poly:')) options.polyphony = parseInt(arg.split(':')[1]) || 8;
        if (arg.startsWith('vol:')) options.globalVolume = parseFloat(arg.split(':')[1]) || 1.0;
        if (arg.startsWith('minvol:')) options.minVolume = parseFloat(arg.split(':')[1]) || 0.15;
    });

    return options;
}

/**
 * 再生ループを開始する共通関数
 * @param {function} tickHandler
 * @param {Player} player
 */
function startPlaybackLoop(tickHandler, player) {
    const runId = system.runInterval(tickHandler, 1);
    playerPlaybackTasks.set(player.id, { runId: runId });
}

/**
 * プレイヤーの前方2ブロックの位置を取得
 * @param {Player} player
 * @returns {{x: number, y: number, z: number}}
 */
function getFrontLocation(player) {
    const location = player.location;
    const viewDirection = player.getViewDirection();

    const length = Math.sqrt(viewDirection.x**2 + viewDirection.y**2 + viewDirection.z**2);
    if (length < 0.001) return location; 

    const normalizedDirection = {
        x: viewDirection.x / length,
        y: viewDirection.y / length,
        z: viewDirection.z / length
    };
    
    const DISTANCE = 6;

    return {
        x: location.x + normalizedDirection.x * DISTANCE,
        y: location.y + normalizedDirection.y * DISTANCE,
        z: location.z + normalizedDirection.z * DISTANCE
    };
}


/**
 * [SIMPLE MODE] シンプルな再生ロジック
 * @param {Array<object>} sequence
 * @param {Player} player
 * @param {object} playOptions
 * @param {function} onComplete
 */
function playSimpleSequence(sequence, player, playOptions, onComplete) {
    let sequenceIndex = 0;
    let currentTick = 0;
    const maxTick = sequence.length > 0 ? sequence[sequence.length - 1].tick : -1;
    if (maxTick < 0) {
        onComplete();
        return;
    }
    
    const fixedLocation = playOptions.stationary ? player.location : null;

    const tickHandler = () => {
        try {
            if (!player.isValid || !playerPlaybackTasks.has(player.id)) {
                system.clearRun(playerPlaybackTasks.get(player.id)?.runId);
                playerPlaybackTasks.delete(player.id);
                return;
            }

            if (currentTick > maxTick) {
                const task = playerPlaybackTasks.get(player.id);
                if (task) system.clearRun(task.runId);

                if (!playOptions.loop) {
                    playerPlaybackTasks.delete(player.id);
                    player.sendMessage("§aシンプル再生が完了しました。");
                }
                onComplete();
                return;
            }
            
            const playbackLocation = fixedLocation || getFrontLocation(player);
            while (sequenceIndex < sequence.length && sequence[sequenceIndex].tick === currentTick) {
                const event = sequence[sequenceIndex];
                player.dimension.playSound("note.harp", playbackLocation, {
                    pitch: 2 ** ((event.pitch - 12) / 12.0),
                    volume: (event.velocity || 0.8) * playOptions.globalVolume
                });
                sequenceIndex++;
            }
            currentTick++;
        } catch (e) {
            console.error("シンプル再生中の致命的なエラー:", JSON.stringify(e, null, 2));
            const task = playerPlaybackTasks.get(player.id);
            if (task) system.clearRun(task.runId);
            playerPlaybackTasks.delete(player.id);
        }
    };
    startPlaybackLoop(tickHandler, player);
}

/**
 * [ADVANCED MODE] 高度な再生ロジック
 * @param {Array<object>} sequence
 * @param {Player} player
 * @param {object} playOptions
 * @param {function} onComplete
 */
function playAdvancedSequence(sequence, player, playOptions, onComplete) {
    let sequenceIndex = 0;
    let currentTick = 0;
    const maxTick = sequence.length > 0 ? sequence[sequence.length - 1].tick : -1;
    if (maxTick < 0) {
        onComplete();
        return;
    }

    const instrumentSoundMap = {
        'planks': 'harp', 'stone': 'bassdrum', 'sand': 'snare', 'glass': 'hat',
        'gold_block': 'bell', 'clay': 'flute', 'packed_ice': 'chime',
        'bone_block': 'xylophone', 'iron_block': 'iron_xylophone', 'pumpkin': 'didgeridoo',
        'emerald_block': 'bit', 'hay_block': 'banjo', 'glowstone': 'pling',
    };
    
    const fixedLocation = playOptions.stationary ? player.location : null;
    const fixedViewDirection = playOptions.stationary ? player.getViewDirection() : null;

    const tickHandler = () => {
        try {
            if (!player.isValid || !playerPlaybackTasks.has(player.id)) {
                system.clearRun(playerPlaybackTasks.get(player.id)?.runId);
                playerPlaybackTasks.delete(player.id);
                return;
            }

            if (currentTick > maxTick) {
                const task = playerPlaybackTasks.get(player.id);
                if (task) system.clearRun(task.runId);

                if (!playOptions.loop) {
                    playerPlaybackTasks.delete(player.id);
                    player.sendMessage("§aアドバンス再生が完了しました。");
                }
                onComplete();
                return;
            }

            const notesToPlayThisTick = [];
            while (sequenceIndex < sequence.length && sequence[sequenceIndex].tick === currentTick) {
                notesToPlayThisTick.push(sequence[sequenceIndex]);
                sequenceIndex++;
            }

            if (notesToPlayThisTick.length > 0) {
                if (!player.isValid) return;
                
                const playbackCenter = fixedLocation || getFrontLocation(player);
                const viewDirection = fixedViewDirection || player.getViewDirection();
                
                const horizontalDirection = { x: viewDirection.x, y: 0, z: viewDirection.z };
                const length = Math.sqrt(horizontalDirection.x**2 + horizontalDirection.z**2);
                if (length > 0.001) {
                    horizontalDirection.x /= length;
                    horizontalDirection.z /= length;
                } else {
                    horizontalDirection.x = 0;
                    horizontalDirection.z = 1;
                }

                const rightVector = { x: horizontalDirection.z, y: 0, z: -horizontalDirection.x };

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
                        const panOffset = (pan - 0.5) * 5.0; 
                        
                        const soundLocation = {
                            x: playbackCenter.x + rightVector.x * panOffset,
                            y: playbackCenter.y,
                            z: playbackCenter.z + rightVector.z * panOffset
                        };

                        if (volume > 0 && isFinite(finalPitch) && isFinite(soundLocation.x)) {
                            player.dimension.playSound(soundId, soundLocation, { pitch: finalPitch, volume });
                        }
                    } catch (innerError) {
                        console.error(`ノート再生エラー:`, JSON.stringify(innerError, null, 2));
                    }
                }
            }
            currentTick++;
        } catch (e) {
            console.error("再生ループ中の致命的なエラー:", JSON.stringify(e, null, 2));
            const task = playerPlaybackTasks.get(player.id);
            if (task) system.clearRun(task.runId);
            playerPlaybackTasks.delete(player.id);
        }
    };
    startPlaybackLoop(tickHandler, player);
}

world.afterEvents.playerLeave.subscribe(ev => {
    const { playerId } = ev;
    if (playerPlaybackTasks.has(playerId)) {
        system.clearRun(playerPlaybackTasks.get(playerId).runId);
        playerPlaybackTasks.delete(playerId);
        console.log(`退出したプレイヤーの再生タスクをクリアしました: ${playerId}`);
    }
});