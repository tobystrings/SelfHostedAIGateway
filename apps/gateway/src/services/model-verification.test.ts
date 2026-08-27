import { describe, expect, it, vi } from "vitest";
import { GatewayError } from "../core/errors.js";
import type { ProviderAdapter } from "../core/provider.js";
import type { GatewayModel } from "../core/types.js";
import { verifyModelInvocation } from "./model-verification.js";

const model = (capabilities: GatewayModel["capabilities"], callable?: boolean): GatewayModel => ({ provider: "p", id: "m", enabled: true, capabilities, callable });
const adapter = (overrides: Partial<ProviderAdapter> = {}): ProviderAdapter => ({
  id: "p", kind: "test", async discoverModels(){return[]},
  async chat(){return { id:"r",provider:"p",model:"m",message:{role:"assistant",content:"ok"},finishReason:"stop",usage:{inputTokens:1,outputTokens:1,totalTokens:2} }},
  async *streamChat(){}, async embeddings(){return {provider:"p",model:"m",data:[],usage:{inputTokens:1,outputTokens:0,totalTokens:1}}},
  async health(){return {ok:true,latencyMs:0}}, ...overrides,
});
const signal = () => new AbortController().signal;

describe("live model verification", () => {
  it("uses embeddings for embedding-only models and chat for text models", async () => {
    const embeddings = vi.fn(async () => ({provider:"p",model:"m",data:[],usage:{inputTokens:1,outputTokens:0,totalTokens:1}}));
    const chat = vi.fn(async () => ({id:"r",provider:"p",model:"m",message:{role:"assistant" as const,content:"ok"},finishReason:"stop",usage:{inputTokens:1,outputTokens:1,totalTokens:2}}));
    expect(await verifyModelInvocation(adapter({embeddings}), model({embeddings:true,textOutput:false}), signal())).toMatchObject({status:"verified",callable:true});
    expect(embeddings).toHaveBeenCalledOnce();
    expect(await verifyModelInvocation(adapter({chat}), model({textInput:true,textOutput:true}), signal())).toMatchObject({status:"verified",callable:true});
    expect(chat).toHaveBeenCalledOnce();
  });

  it("does not invoke unsupported specialized models", async () => {
    const chat = vi.fn();
    expect(await verifyModelInvocation(adapter({chat}), model({textOutput:false,embeddings:false}), signal())).toEqual({status:"unsupported_verification",errorCategory:"unsupported_capability",callable:undefined});
    expect(chat).not.toHaveBeenCalled();
  });

  it("marks 404 unavailable but does not permanently disable a rate-limited model", async () => {
    const failure = (status:number) => async () => { throw new GatewayError({code:`upstream_${status}`,message:"sanitized",type:status===429?"rate_limit":"provider",retryable:status===429,status}); };
    expect(await verifyModelInvocation(adapter({chat:failure(404)}), model({textOutput:true}), signal())).toMatchObject({status:"unavailable",callable:false,errorCategory:"upstream_404"});
    expect(await verifyModelInvocation(adapter({chat:failure(429)}), model({textOutput:true},true), signal())).toMatchObject({status:"rate_limited",callable:true,errorCategory:"upstream_429"});
  });
});
