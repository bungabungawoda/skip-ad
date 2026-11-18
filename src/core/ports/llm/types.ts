/** LLM 端口的类型契约：消息形状，fetch 实现留在 Service Worker。 */

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
