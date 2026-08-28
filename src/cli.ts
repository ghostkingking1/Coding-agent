import { Agent, ToolRegistry, type ModelClient, type ModelRequest, type ModelResponse } from "./index.ts";

class EchoModel implements ModelClient {
  readonly provider = "echo";
  readonly model = "echo";
  readonly capabilities = { toolCalling: false, streaming: false } as const;

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const prompt = request.messages.findLast((message) => message.role === "user")?.content ?? "";
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
