export type Role='system'|'developer'|'user'|'assistant'|'tool';
export interface TextBlock{type:'text';text:string} export interface ImageBlock{type:'image';url?:string;base64?:string;mimeType?:string} export type ContentBlock=TextBlock|ImageBlock;
export interface ToolCall{id:string;name:string;arguments:string} export interface Message{role:Role;content:string|ContentBlock[];name?:string;toolCallId?:string;toolCalls?:ToolCall[]}
export interface ToolDefinition{name:string;description?:string;parameters:Record<string,unknown>}
export interface StructuredOutput{name?:string;schema:Record<string,unknown>;strict?:boolean}
export interface ChatRequest{provider?:string;model?:string;messages:Message[];stream?:boolean;temperature?:number;maxOutputTokens?:number;tools?:ToolDefinition[];toolChoice?:unknown;structuredOutput?:StructuredOutput;metadata?:Record<string,unknown>}
export interface Usage{inputTokens:number;outputTokens:number;totalTokens:number;cachedInputTokens?:number;reasoningTokens?:number;estimatedCostUsd?:number;actualCostUsd?:number}
export interface ChatResponse{id:string;provider:string;model:string;message:Message;finishReason:string;usage:Usage;metadata?:Record<string,unknown>}
export type StreamEvent={type:'start';id:string;model:string}|{type:'text_delta';text:string}|{type:'tool_call_delta';id:string;name?:string;arguments?:string}|{type:'finish';finishReason:string}|{type:'usage';usage:Usage}|{type:'error';code:string;message:string};
export interface EmbeddingRequest{provider?:string;model?:string;input:string|string[]} export interface EmbeddingResponse{provider:string;model:string;data:{index:number;embedding:number[]}[];usage:Usage}
export interface ModelCapabilities{textInput?:boolean;textOutput?:boolean;imageInput?:boolean;audioInput?:boolean;toolCalling?:boolean;parallelToolCalling?:boolean;structuredOutput?:boolean;embeddings?:boolean;reasoning?:boolean;streaming?:boolean;contextWindow?:number;maxOutputTokens?:number}
export interface Pricing{inputPerMillionUsd:number;outputPerMillionUsd:number;cachedInputPerMillionUsd?:number;effectiveFrom?:string}
export interface GatewayModel{provider:string;id:string;displayName?:string;enabled:boolean;capabilities:ModelCapabilities;pricing?:Pricing;metadata?:Record<string,unknown>}
