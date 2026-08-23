import { Agent, ToolRegistry, type Message, type Model, type ModelResponse } from "./index.ts";

class EchoModel implements Model {
  async generate(messages: readonly Message[]): Promise<ModelResponse> {
    const prompt = messages.findLast((message) => message.role === "user")?.content ?? "";
    return {
      message: { role: "assistant", content: `Received: ${prompt}` },
      finishReason: "stop",
    };
  }
}

const input = process.argv.slice(2).join(" ").trim();
if (!input) {
  console.error("Usage: npm start -- <request>");
  process.exitCode = 1;
} else {
  const agent = new Agent(new EchoModel(), new ToolRegistry(), {
    systemPrompt: "You are a minimal coding agent.",
  });
  const result = await agent.run(input);
  console.log(result.finalText);
}
