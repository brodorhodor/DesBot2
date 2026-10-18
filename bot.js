
require("dotenv").config();

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const {
    Client,
    GatewayIntentBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    EmbedBuilder,
    MessageFlags,
} = require("discord.js");

const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    entersState,
    VoiceConnectionStatus,
    AudioPlayerStatus,
    NoSubscriberBehavior,
    demuxProbe,
} = require("@discordjs/voice");

const {
    DISCORD_TOKEN,
    ELEVENLABS_API_KEY,
    DISCORD_USER_ID,
    DISCORD_CHANNEL_ID,
    ELEVENLABS_VOICE_ID,
} = process.env;

const required = {
    DISCORD_TOKEN,
    ELEVENLABS_API_KEY,
    DISCORD_USER_ID,
    DISCORD_CHANNEL_ID,
    ELEVENLABS_VOICE_ID,
};

for (const [name, value] of Object.entries(required)) {
    if (!value) {
        console.error(`Missing configuration: ${name}`);
        process.exit(1);
    }
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
    ],
});

const player = createAudioPlayer({
    behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause,
    },
});

let connection = null;
let activeGuildId = null;
let activeChannelId = null;
let disconnectTimer = null;
let processing = false;

const queue = [];

// Default voice comes from your .env file (Kafka).
const SETTINGS_FILE = path.join(process.env.DESBOT_DATA_DIR || __dirname, "desbot-settings.json");

function loadSavedVoice() {
    try {
        const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
        return settings.voiceId || ELEVENLABS_VOICE_ID;
    } catch {
        return ELEVENLABS_VOICE_ID;
    }
}

function saveSelectedVoice(voiceId) {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ voiceId }, null, 2));
}

let selectedVoiceId = loadSavedVoice();

// Voice menu pagination.
const VOICES_PER_PAGE = 25;
const voiceMenus = new Map();

function resetDisconnectTimer() {
    if (disconnectTimer) clearTimeout(disconnectTimer);

    disconnectTimer = setTimeout(() => {
        if (processing || queue.length > 0) {
            resetDisconnectTimer();
            return;
        }

        console.log("45 minutes of inactivity. Disconnecting.");

        player.stop(true);

        if (connection) {
            connection.destroy();
            connection = null;
        }

        activeGuildId = null;
        activeChannelId = null;
    }, 45 * 60 * 1000);
}

async function connectToVoice(channel) {
    if (
        connection &&
        activeGuildId === channel.guild.id &&
        activeChannelId === channel.id &&
        connection.state.status !== VoiceConnectionStatus.Destroyed
    ) {
        console.log("Reusing existing voice connection.");

        if (!connection.state.subscription) {
            connection.subscribe(player);
        }

        console.log(
            "Audio subscription:",
            connection.state.subscription ? "ACTIVE" : "MISSING"
        );

        return;
    }

    if (connection) {
        connection.destroy();
        connection = null;
    }

    console.log(`Joining voice channel: ${channel.name}`);

    connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: false,
    });

    connection.on("stateChange", (oldState, newState) => {
        console.log(
            `Voice connection: ${oldState.status} -> ${newState.status}`
        );
    });

    connection.on("error", (error) => {
        console.error("Voice connection error:", error);
    });

    activeGuildId = channel.guild.id;
    activeChannelId = channel.id;

    try {
        await entersState(
            connection,
            VoiceConnectionStatus.Ready,
            20000
        );

        connection.subscribe(player);

        console.log(
            "Audio subscription:",
            connection.state.subscription ? "ACTIVE" : "MISSING"
        );

        console.log("Connected to voice channel.");
    } catch (error) {
        connection.destroy();
        connection = null;
        activeGuildId = null;
        activeChannelId = null;
        throw error;
    }
}

async function generateSpeech(text) {
    console.log("Generating speech with ElevenLabs...");
    console.log("Selected voice ID:", selectedVoiceId);

    const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${selectedVoiceId}`,
        {
            method: "POST",
            headers: {
                "xi-api-key": ELEVENLABS_API_KEY,
                "Content-Type": "application/json",
                Accept: "audio/mpeg",
            },
            body: JSON.stringify({
                text,
                model_id: "eleven_multilingual_v2",
            }),
        }
    );

    if (!response.ok) {
        const error = await response.text();

        throw new Error(
            `ElevenLabs error ${response.status}: ${error}`
        );
    }

    const audio = Buffer.from(await response.arrayBuffer());

    console.log("Audio downloaded:", audio.length, "bytes");
    console.log(
        "Audio content type:",
        response.headers.get("content-type")
    );

    if (audio.length === 0) {
        throw new Error("ElevenLabs returned an empty audio file.");
    }

    const filename = path.join(
        os.tmpdir(),
        `desbot2-${randomUUID()}.mp3`
    );

    await fs.promises.writeFile(filename, audio);

    return filename;
}

function playAudio(filename) {
    return new Promise((resolve, reject) => {
        console.log("Preparing audio:", filename);

        let resource;

        try {
            resource = createAudioResource(filename);
        } catch (error) {
            reject(error);
            return;
        }

        console.log("Audio resource created.");
        console.log("Player state before playback:", player.state.status);

        let settled = false;

        const cleanup = () => {
            player.off(AudioPlayerStatus.Idle, onIdle);
            player.off("error", onError);
        };

        const onIdle = () => {
            if (settled) return;
            settled = true;
            cleanup();

            console.log("Audio player reached Idle.");
            resolve();
        };

        const onError = (error) => {
            if (settled) return;
            settled = true;
            cleanup();

            console.error("Audio playback error:", error);
            reject(error);
        };

        player.once(AudioPlayerStatus.Idle, onIdle);
        player.once("error", onError);

        player.play(resource);

        console.log("Audio playback requested.");
        console.log("Player state after play():", player.state.status);
        console.log(
            "Subscription at playback:",
            connection?.state.subscription ? "ACTIVE" : "MISSING"
        );
    });
}

async function processQueue() {
    if (processing) return;

    processing = true;

    try {
        while (queue.length > 0) {
            const item = queue.shift();
            let filename = null;

            try {
                await connectToVoice(item.channel);

                filename = await generateSpeech(item.text);

                console.log(`Speaking: ${item.text}`);

                await playAudio(filename);

                console.log("Finished speaking.");
                resetDisconnectTimer();
            } catch (error) {
                console.error("TTS/playback error:", error);
                player.stop(true);
            } finally {
                if (filename) {
                    await fs.promises.unlink(filename).catch(() => {});
                }
            }
        }
    } finally {
        processing = false;
    }
}

function createConfigPanel() {
    const embed = new EmbedBuilder()
        .setTitle("DesBot 2.0 — ElevenLabs Settings")
        .setDescription(
            "Configure your text-to-speech voice and audio settings."
        )
        .setColor(0x5865F2);

    const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId("desbot_voice")
            .setLabel("Set voice")
            .setStyle(ButtonStyle.Primary),

        new ButtonBuilder()
            .setCustomId("desbot_stability")
            .setLabel("Set stability")
            .setStyle(ButtonStyle.Secondary),

        new ButtonBuilder()
            .setCustomId("desbot_similarity")
            .setLabel("Set similarity boost")
            .setStyle(ButtonStyle.Secondary),

        new ButtonBuilder()
            .setCustomId("desbot_speaker")
            .setLabel("Speaker boost")
            .setStyle(ButtonStyle.Secondary)
    );

    return {
        embeds: [embed],
        components: [buttons],
    };
}

async function getElevenLabsVoices() {
    const voices = [];
    let nextPageToken = null;

    do {
        const url = new URL(
            "https://api.elevenlabs.io/v2/voices"
        );

        url.searchParams.set("page_size", "100");

        if (nextPageToken) {
            url.searchParams.set("next_page_token", nextPageToken);
        }

        const response = await fetch(url, {
            headers: {
                "xi-api-key": ELEVENLABS_API_KEY,
            },
        });

        if (!response.ok) {
            throw new Error(
                `Could not fetch voices: ${response.status} ${await response.text()}`
            );
        }

        const data = await response.json();

        for (const voice of data.voices || []) {
            voices.push({
                name: voice.name,
                id: voice.voice_id,
            });
        }

        nextPageToken = data.has_more
            ? data.next_page_token
            : null;
    } while (nextPageToken);

    return voices.sort((a, b) =>
        a.name.localeCompare(b.name)
    );
}

function createVoiceMenu(voices, page) {
    const totalPages = Math.ceil(voices.length / VOICES_PER_PAGE);
    const safePage = Math.max(0, Math.min(page, totalPages - 1));

    const start = safePage * VOICES_PER_PAGE;
    const currentVoices = voices.slice(
        start,
        start + VOICES_PER_PAGE
    );

    const options = currentVoices.map((voice) => ({
        label: voice.name.slice(0, 100),
        value: voice.id,
        default: voice.id === selectedVoiceId,
    }));

    const menu = new StringSelectMenuBuilder()
        .setCustomId("desbot_voice_select")
        .setPlaceholder("Choose your ElevenLabs voice")
        .addOptions(options);

    const menuRow = new ActionRowBuilder().addComponents(menu);

    const navigationRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId("desbot_voice_previous")
            .setLabel("Previous")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(safePage === 0),

        new ButtonBuilder()
            .setCustomId("desbot_voice_next")
            .setLabel("Next")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(safePage >= totalPages - 1)
    );

    return {
        content:
            `Select a voice for DesBot 2.0.\n` +
            `Page ${safePage + 1} of ${totalPages} ` +
            `(${voices.length} voices total)`,
        components: [menuRow, navigationRow],
    };
}

client.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    if (message.author.id !== DISCORD_USER_ID) return;
    if (message.channel.id !== DISCORD_CHANNEL_ID) return;
    if (!message.guild) return;

    const text = message.content.trim();
    if (!text) return;

    if (text.toLowerCase() === "!config") {
        await message.reply(createConfigPanel());
        return;
    }

    try {
        const member = await message.guild.members.fetch(
            message.author.id
        );

        const voiceChannel = member.voice.channel;

        if (!voiceChannel) {
            console.log("Message ignored: you're not in voice.");
            return;
        }

        queue.push({
            text: text.slice(0, 1000),
            channel: voiceChannel,
        });

        resetDisconnectTimer();
        processQueue().catch(console.error);
    } catch (error) {
        console.error("Message handling error:", error);
    }
});

client.on("interactionCreate", async (interaction) => {
    try {
        if (
            !interaction.isButton() &&
            !interaction.isStringSelectMenu()
        ) {
            return;
        }

        if (!interaction.customId.startsWith("desbot_")) return;

        if (interaction.user.id !== DISCORD_USER_ID) {
            await interaction.reply({
                content: "Only the bot owner can change settings.",
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        if (
            interaction.isButton() &&
            interaction.customId === "desbot_voice"
        ) {
            await interaction.deferReply({
                flags: MessageFlags.Ephemeral,
            });

            const voices = await getElevenLabsVoices();

            if (voices.length === 0) {
                await interaction.editReply(
                    "No ElevenLabs voices found."
                );
                return;
            }

            voiceMenus.set(interaction.user.id, {
                voices,
                page: 0,
            });

            await interaction.editReply(
                createVoiceMenu(voices, 0)
            );

            return;
        }

        if (
            interaction.isButton() &&
            (
                interaction.customId === "desbot_voice_previous" ||
                interaction.customId === "desbot_voice_next"
            )
        ) {
            const state = voiceMenus.get(interaction.user.id);

            if (!state) {
                await interaction.reply({
                    content: "Open Set voice again to refresh the list.",
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            if (interaction.customId === "desbot_voice_previous") {
                state.page--;
            } else {
                state.page++;
            }

            const totalPages = Math.ceil(
                state.voices.length / VOICES_PER_PAGE
            );

            state.page = Math.max(
                0,
                Math.min(state.page, totalPages - 1)
            );

            await interaction.update(
                createVoiceMenu(state.voices, state.page)
            );

            return;
        }

        if (
            interaction.isStringSelectMenu() &&
            interaction.customId === "desbot_voice_select"
        ) {
            const state = voiceMenus.get(interaction.user.id);
            const chosenId = interaction.values[0];

            if (
                !state ||
                !state.voices.some((voice) => voice.id === chosenId)
            ) {
                await interaction.reply({
                    content: "That voice isn't available. Reopen Set voice.",
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            saveSelectedVoice(chosenId);
            selectedVoiceId = chosenId;

            const selectedVoice = state.voices.find(
                (voice) => voice.id === chosenId
            );

            console.log(
                `Voice changed to: ${selectedVoice.name} (${selectedVoiceId})`
            );

            await interaction.update({
                content: `Voice changed to **${selectedVoice.name}**!`,
                components: [],
            });

            return;
        }

        if (interaction.isButton()) {
            await interaction.reply({
                content:
                    "This setting is coming soon. Let's get audio working first!",
                flags: MessageFlags.Ephemeral,
            });
        }
    } catch (error) {
        console.error("Configuration interaction error:", error);

        const message = "Something went wrong with the configuration menu.";

        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({
                content: message,
                components: [],
            }).catch(console.error);
        } else {
            await interaction.reply({
                content: message,
                flags: MessageFlags.Ephemeral,
            }).catch(console.error);
        }
    }
});

player.on("stateChange", (oldState, newState) => {
    console.log(
        `Audio player: ${oldState.status} -> ${newState.status}`
    );
});

player.on("error", (error) => {
    console.error("Global audio player error:", error);
});

client.once("clientReady", () => {
    console.log("--------------------------------");
    console.log(`DesBot2 online as ${client.user.tag}`);
    console.log(`Default voice ID: ${ELEVENLABS_VOICE_ID}`);
    console.log(`Selected voice ID: ${selectedVoiceId}`);
    console.log("Waiting for messages...");
    console.log("--------------------------------");
});

client.on("error", console.error);

process.on("SIGINT", () => {
    console.log("Shutting down...");

    if (disconnectTimer) clearTimeout(disconnectTimer);

    player.stop(true);
    connection?.destroy();
    client.destroy();

    process.exit(0);
});

client.login(DISCORD_TOKEN).catch((error) => {
    console.error("Discord login failed:", error.message);
    process.exit(1);
});
