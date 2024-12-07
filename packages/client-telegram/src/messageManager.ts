import { Message } from "@telegraf/types";
import { Context, Telegraf } from "telegraf";

import { composeContext, elizaLogger } from "@ai16z/eliza";
import { embeddingZeroVector } from "@ai16z/eliza";
import {
    Content,
    HandlerCallback,
    IAgentRuntime,
    IImageDescriptionService,
    Memory,
    ModelClass,
    State,
    UUID,
} from "@ai16z/eliza";
import { stringToUuid } from "@ai16z/eliza";

import { generateMessageResponse, generateShouldRespond } from "@ai16z/eliza";
import { messageCompletionFooter, shouldRespondFooter } from "@ai16z/eliza";
import { ImageDescriptionService } from "@ai16z/plugin-node";

const MAX_MESSAGE_LENGTH = 4096; // Telegram's max message length

const telegramShouldRespondTemplate =
`你的名字 {{agentName}} 你的身份 {{role}}

下面我会给你交互示例和当前消息，根据消息内容和上述规则决定是否回复
# 如果匹配如下示例,按照Result回复
{{user1}}: 天黑请闭眼
Result: [IGNORE]

{{user1}}: 天亮了
Result: [IGNORE]

{{user1}}: 请睁眼
Result: [IGNORE]

{{user1}}: 请闭眼
Result: [IGNORE]

{{user1}}: 游戏开始
Result: [IGNORE]

{{user1}}: 请投票选择放逐对象
Result: [RESPOND]

#消息
{{recentMessages}}

上面是上一条消息
如果上一条消息来自 reubenhe 或者 Anne_AmberGroup 回复[RESPOND]
如果上一条消息包含{{agentName}}或者{{role}} 回复[RESPOND]


# 回复选项
[RESPOND], [IGNORE], [STOP].

# INSTRUCTIONS: Choose the option that best describes {{agentName}}'s response to the last message
` + shouldRespondFooter;

const telegramMessageHandlerTemplate =
    // {{goals}}
    `# Action Examples
{{actionExamples}}
(Action examples are for reference only. Do not use the information from them in your response.)

# Knowledge
{{knowledge}}

# Task: Generate dialog and actions for the character {{agentName}}.
About {{agentName}}:
{{bio}}
{{lore}}

# 背景
你们在玩一场六人局的狼人杀游戏，请按照狼人杀规则，根据你的身份、发言顺序结合当前最新消息发言。你的目标是带领阵营胜利，你需要隐藏自己身份并且推理其他人的身份，将其他阵营的角色投票出去或者杀死。

# 狼人杀规则和流程
6人狼人游戏的配置为: 2个村民、1个预言家、1个女巫和2个狼人。其中2个村民、预言家和女巫归属为好人阵营,而2个狼人则为狼人阵营,好人阵营获胜条件是放逐所有的狼人,狼人胜利条件是杀光所有好人。
由主持人reubenhe决定游戏进程和其他玩家的动作,比如天黑了所有玩家闭眼、天亮了所有玩家睁眼、昨晚是平安夜、昨晚谁死了、预言家查验身份、女巫是否用药等
请根据主持人reubenhe的发言 以及 游戏流程规则 来决定是否回复
夜晚阶段所有玩家闭眼：主持人说天黑请闭眼进入夜晚阶段。
1.狼人睁眼：狼人互相知道队友身份，选择一名玩家进行“杀害”。
2.预言家睁眼：预言家可以选择一名玩家查验其身份（是否是狼人）。主持人告诉预言家该玩家的身份。每晚只能检查一个玩家。
3.女巫睁眼：女巫首先会得知是否有玩家在狼人攻击中受伤。如果有玩家被狼人攻击，女巫可以选择使用解药救活该玩家。女巫也可以选择使用毒药毒死一名玩家，但每晚只能使用一次毒药。
4.夜晚结束：所有角色完成行动后，主持人宣布夜晚结束，所有玩家睁眼。
5.白天阶段死亡玩家揭示：主持人说天亮了，宣布谁在夜晚被狼人杀害。如果有玩家死亡，主持人会揭示该玩家的身份。
6.讨论阶段：所有存活的玩家开始按照顺序讨论发言，推理死者身份并猜测谁是狼人。玩家可以根据言辞、行为、投票等进行交流，但狼人会伪装自己，尽量不暴露身份。
7.投票阶段：所有玩家轮流投票，选择一名玩家进行处决。投票可以选择“杀”或“不杀”。如果投票结果平票，可以通过再次投票或随机决定。
8.执行处决：被投票人数最多的玩家会被处决。主持人揭示该玩家的身份。
9.结束白天阶段：然后进入下一轮夜晚阶段。重复夜晚和白天阶段，直到出现胜利条件。

# 参与的玩家
wuchang,niutou,yuyu,xiaobai,mamian,mengpo


# 最近的消息
{{recentMessages}}

回复内容尽量围绕其他人发言内容来进行推理和猜测，尽量有分析思路和分析结果给到结论中，语言风格尽量包含个人性格元素但又不能非常啰嗦

# Task: Generate a post/reply in the voice, style and perspective of {{agentName}} (@{{twitterUserName}}) while using the thread of tweets as additional context:
Current Post:
{{currentPost}}
Thread of Tweets You Are Replying To:

{{formattedConversation}}
` + messageCompletionFooter;

export class MessageManager {
    public bot: Telegraf<Context>;
    private runtime: IAgentRuntime;
    private imageService: IImageDescriptionService;

    constructor(bot: Telegraf<Context>, runtime: IAgentRuntime) {
        this.bot = bot;
        this.runtime = runtime;
        this.imageService = ImageDescriptionService.getInstance();
        // 启动room msg消息监听
        this.loopMsgListiner();
    }

    // Process image messages and generate descriptions
    private async processImage(
        message: Message
    ): Promise<{ description: string } | null> {
        // console.log(
        //     "🖼️ Processing image message:",
        //     JSON.stringify(message, null, 2)
        // );

        try {
            let imageUrl: string | null = null;

            // Handle photo messages
            if ("photo" in message && message.photo?.length > 0) {
                const photo = message.photo[message.photo.length - 1];
                const fileLink = await this.bot.telegram.getFileLink(
                    photo.file_id
                );
                imageUrl = fileLink.toString();
            }
            // Handle image documents
            else if (
                "document" in message &&
                message.document?.mime_type?.startsWith("image/")
            ) {
                const doc = message.document;
                const fileLink = await this.bot.telegram.getFileLink(
                    doc.file_id
                );
                imageUrl = fileLink.toString();
            }

            if (imageUrl) {
                const { title, description } =
                    await this.imageService.describeImage(imageUrl);
                const fullDescription = `[Image: ${title}\n${description}]`;
                return { description: fullDescription };
            }
        } catch (error) {
            console.error("❌ Error processing image:", error);
        }

        return null; // No image found
    }

    // Decide if the bot should respond to the message
    private async _shouldRespond(
        message: Message,
        state: State
    ): Promise<boolean> {
        // Respond if bot is mentioned

        if (
            "text" in message &&
            message.text?.includes(`@${this.bot.botInfo?.username}`)
        ) {
            return true;
        }

        // Respond to private chats
        if (message.chat.type === "private") {
            return true;
        }

        // Respond to images in group chats
        if (
            "photo" in message ||
            ("document" in message &&
                message.document?.mime_type?.startsWith("image/"))
        ) {
            return false;
        }

        // Use AI to decide for text or captions
        if ("text" in message || ("caption" in message && message.caption)) {
            const shouldRespondContext = composeContext({
                state,
                template:
                    this.runtime.character.templates
                        ?.telegramShouldRespondTemplate ||
                    this.runtime.character?.templates?.shouldRespondTemplate ||
                    telegramShouldRespondTemplate,
            });

            const response = await generateShouldRespond({
                runtime: this.runtime,
                context: shouldRespondContext,
                modelClass: ModelClass.SMALL,
            });
            elizaLogger.info("ai response", response)
            return response === "RESPOND";
        }

        return false; // No criteria met
    }

    // Send long messages in chunks
    private async sendMessageInChunks(
        ctx: Context,
        content: string,
        replyToMessageId?: number
    ): Promise<Message.TextMessage[]> {
        const chunks = this.splitMessage(content);
        const sentMessages: Message.TextMessage[] = [];

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const sentMessage = (await ctx.telegram.sendMessage(
                ctx.chat.id,
                chunk,
                // {
                //     reply_parameters:
                //         i === 0 && replyToMessageId
                //             ? { message_id: replyToMessageId }
                //             : undefined,
                // }
            )) as Message.TextMessage;

            sentMessages.push(sentMessage);
        }

        return sentMessages;
    }

    // Split message into smaller parts
    private splitMessage(text: string): string[] {
        const chunks: string[] = [];
        let currentChunk = "";

        const lines = text.split("\n");
        for (const line of lines) {
            if (currentChunk.length + line.length + 1 <= MAX_MESSAGE_LENGTH) {
                currentChunk += (currentChunk ? "\n" : "") + line;
            } else {
                if (currentChunk) chunks.push(currentChunk);
                currentChunk = line;
            }
        }

        if (currentChunk) chunks.push(currentChunk);
        return chunks;
    }

    // Generate a response using AI
    private async _generateResponse(
        message: Memory,
        state: State,
        context: string
    ): Promise<Content> {
        const { userId, roomId } = message;

        const response = await generateMessageResponse({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.SMALL,
        });

        if (!response) {
            console.error("❌ No response from generateMessageResponse");
            return null;
        }
        await this.runtime.databaseAdapter.log({
            body: { message, context, response },
            userId: userId,
            roomId,
            type: "response",
        });

        return response;
    }

    private async loopMsgListiner() {
        var length = 0
        while(true) {
            await this.runtime.messageManager.getMemoriesByRoomIds({roomIds: ["db86f761-6fdc-016f-b4fa-48e11ef2a23b"]}).then((memories) => {
                if (memories.length > length) {
                    if (length > 0) {
                        var lastMemory = memories[length]
                        this.msgCall(lastMemory)
                    }
                    length = memories.length
                }
            });
            await new Promise(resolve => setTimeout(resolve, 1000)); // Pause for 1 second
        }
    }

    // Main handler for incoming messages
    public async handleMessage(ctx: Context): Promise<void> {
        if (!ctx.message || !ctx.from) {
            return; // Exit if no message or sender info
        }

        // if (
        //     this.runtime.character.clientConfig?.telegram
        //         ?.shouldIgnoreBotMessages &&
        //     ctx.from.is_bot
        // ) {
        //     return;
        // }
        if (
            this.runtime.character.clientConfig?.telegram
                ?.shouldIgnoreDirectMessages &&
            ctx.chat?.type === "private"
        ) {
            return;
        }

        const message = ctx.message;

        try {
            // Convert IDs to UUIDs
            const userId = stringToUuid(ctx.from.id.toString()) as UUID;
            const userName =
                ctx.from.username || ctx.from.first_name || "Unknown User";
            const chatId = stringToUuid(ctx.chat?.id.toString()) as UUID;
            const agentId = this.runtime.agentId;
            const roomId = chatId;

            await this.runtime.ensureConnection(
                userId,
                roomId,
                userName,
                userName,
                "telegram"
            );

            const messageId = stringToUuid(
                message.date.toString()
            ) as UUID;

            // Handle images
            const imageInfo = await this.processImage(message);

            // Get text or caption
            let messageText = "";
            if ("text" in message) {
                messageText = message.text;
            } else if ("caption" in message && message.caption) {
                messageText = message.caption;
            }

            // Combine text and image description
            const fullText = imageInfo
                ? `${messageText} ${imageInfo.description}`
                : messageText;

            if (!fullText) {
                return; // Skip if no content
            }

            const content: Content = {
                text: fullText,
                source: "telegram",
                // inReplyTo:
                //     "reply_to_message" in message && message.reply_to_message
                //         ? stringToUuid(
                //               message.reply_to_message.message_id.toString() +
                //                   "-" +
                //                   this.runtime.agentId
                //           )
                //         : undefined,
            };

            // Create memory for the message
            const memory: Memory = {
                id: messageId,
                agentId,
                userId,
                roomId,
                content,
                createdAt: message.date * 1000,
                embedding: embeddingZeroVector,
            };

            await this.runtime.messageManager.createMemory(memory);

            // Update state with the new memory
            // let state = await this.runtime.composeState(memory);
            // 会将该 room的所有聊天记录按照时间线顺序输出
            // state = await this.runtime.updateRecentMessageState(state);
            // elizaLogger.info(state.recentMessages);

            // Decide whether to respond
            // const shouldRespond = await this._shouldRespond(message, state);
            // const shouldRespond = true;

            // if (shouldRespond) {
            //     // Generate response
            //     const context = composeContext({
            //         state,
            //         template:
            //             this.runtime.character.templates
            //                 ?.telegramMessageHandlerTemplate ||
            //             this.runtime.character?.templates
            //                 ?.messageHandlerTemplate ||
            //             telegramMessageHandlerTemplate,
            //     });

            //     const responseContent = await this._generateResponse(
            //         memory,
            //         state,
            //         context
            //     );

            //     // if (!responseContent || !responseContent.text) return;

            //     // Send response in chunks
            //     const callback: HandlerCallback = async (content: Content) => {
            //         const sentMessages = await this.sendMessageInChunks(
            //             ctx,
            //             content.text,
            //             message.message_id
            //         );

            //         const memories: Memory[] = [];

            //         // Create memories for each sent message
            //         for (let i = 0; i < sentMessages.length; i++) {
            //             const sentMessage = sentMessages[i];
            //             const isLastMessage = i === sentMessages.length - 1;

            //             const memory: Memory = {
            //                 id: stringToUuid(
            //                     sentMessage.message_id.toString() +
            //                         "-" +
            //                         this.runtime.agentId
            //                 ),
            //                 agentId: agentId,
            //                 userId: agentId,
            //                 roomId: roomId,
            //                 content: {
            //                     ...content,
            //                     text: sentMessage.text,
            //                     inReplyTo: messageId,
            //                 },
            //                 createdAt: sentMessage.date * 1000,
            //                 embedding: embeddingZeroVector,
            //             };

            //             // Set action to CONTINUE for all messages except the last one
            //             // For the last message, use the original action from the response content
            //             memory.content.action = !isLastMessage
            //                 ? "CONTINUE"
            //                 : content.action;

            //             await this.runtime.messageManager.createMemory(memory);
            //             memories.push(memory);
            //         }

            //         return memories;
            //     };

            //     // Execute callback to send messages and log memories
            //     const responseMessages = await callback(responseContent);

            //     // Update state after response
            //     state = await this.runtime.updateRecentMessageState(state);

            //     // Handle any resulting actions
            //     await this.runtime.processActions(
            //         memory,
            //         responseMessages,
            //         state,
            //         callback
            //     );
            // }

            // await this.runtime.evaluate(memory, state, shouldRespond);
        } catch (error) {
            console.error("❌ Error handling message:", error);
            console.error("Error sending message:", error);
        }
    }

    private async msgCall(memory: Memory) {
        // elizaLogger.info(JSON.stringify(memory))
        let state = await this.runtime.composeState(memory);
        
        // Decide whether to respond
        state.role = this.runtime.character.role;
        const shouldRespond = await this._shouldRespondInner(state);

        if (shouldRespond) {
            // 会将该 room的所有聊天记录按照时间线顺序输出
            state = await this.runtime.updateRecentMessageState(state);
            // Generate response
            const context = composeContext({
                state,
                template:
                    this.runtime.character.templates
                        ?.telegramMessageHandlerTemplate ||
                    this.runtime.character?.templates
                        ?.messageHandlerTemplate ||
                    telegramMessageHandlerTemplate,
            });

            const responseContent = await this._generateResponse(
                memory,
                state,
                context
            );

            // sendmsg
            var msgResult = await this.bot.telegram.sendMessage(-4540792649, responseContent.text) as Message.TextMessage;

            // create memory
            const newMemory: Memory = {
                id: stringToUuid(
                    msgResult.date.toString() +
                        "-" +
                        this.runtime.agentId
                ),
                agentId: this.runtime.agentId,
                userId: this.runtime.agentId,
                roomId: memory.roomId,
                content: {
                    ...responseContent,
                    text: msgResult.text,
                },
                createdAt: msgResult.date * 1000,
                embedding: embeddingZeroVector,
            };

            await this.runtime.messageManager.createMemory(newMemory);
            // Update state after response
            state = await this.runtime.updateRecentMessageState(state);
        }
    }

    private async _shouldRespondInner(
        state: State
    ): Promise<boolean> {
        const message = this.getLastMessage(state.recentMessages)
        // Find the last non-empty message
        state.recentMessages = message
        // elizaLogger.info(state.recentMessages)
        const shouldRespondContext = composeContext({
            state,
            template:
                this.runtime.character.templates
                    ?.telegramShouldRespondTemplate ||
                this.runtime.character?.templates?.shouldRespondTemplate ||
                telegramShouldRespondTemplate,
        });

        const response = await generateShouldRespond({
            runtime: this.runtime,
            context: shouldRespondContext,
            modelClass: ModelClass.SMALL,
        });
        var logmsg = this.runtime.character.role + state.agentName + " ai response: " + response
        elizaLogger.info(logmsg)
        return response === "RESPOND";
    }

    private getLastMessage(conversation: string): string {
        // Split the conversation by newline characters
        const messages = conversation.trim().split('\n');
        
        // Find the last non-empty message
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].trim() !== '') {
                return messages[i];
            }
        }
        
        // Return an empty string if no message is found
        return '';
    }
}
