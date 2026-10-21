/**
 * How many minutes a chat waits for the human's next message before its sandbox goes, when
 * the agent profile sets no `spec.chat.idleMinutes`: the default the agent profile schema
 * names (contracts/schemas/agent-profile.schema.yaml; a test keeps both equal).
 */
export const DEFAULT_CHAT_IDLE_MINUTES = 5;
