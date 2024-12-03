import { elizaLogger } from "@ai16z/eliza";
import { Client, IAgentRuntime } from "@ai16z/eliza";
import { TelegramClient } from "./telegramClient.ts";
import { validateTelegramConfig } from "./enviroment.ts";

export const TelegramClientInterface: Client = {
    start: async (runtime: IAgentRuntime) => {
        // await validateTelegramConfig(runtime);

        var tokenKey = "TELEGRAM_BOT_TOKEN" + "_" + runtime.character.name;
        const tg = new TelegramClient(
            runtime,
            runtime.getSetting(tokenKey)
        );

        await tg.start();

        elizaLogger.success(
            `✅ Telegram client successfully started for character ${runtime.character.name}`
        );
        return tg;
    },
    stop: async (runtime: IAgentRuntime) => {
        console.warn("Telegram client does not support stopping yet");
    },
};

export default TelegramClientInterface;
