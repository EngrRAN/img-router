// ================= 渠道配置 =================
// 支持：火山引擎 (VolcEngine/豆包)、Gitee (模力方舟)、ModelScope (魔搭)、Hugging Face

// 渠道配置接口
export interface ProviderConfig {
  apiUrl: string;
  defaultModel: string;
  defaultSize: string;      // 文生图默认尺寸
  defaultEditSize: string;  // 图生图默认尺寸
  supportedModels: string[];
}

// Hugging Face 多 URL 配置接口（支持故障转移）
export interface HuggingFaceProviderConfig {
  apiUrls: string[];  // URL 资源池，按优先级排序
  defaultModel: string;
  defaultSize: string;      // 文生图默认尺寸
  defaultEditSize: string;  // 图生图默认尺寸
  supportedModels: string[];
}

// 火山引擎（豆包）配置
export const VolcEngineConfig: ProviderConfig = {
  apiUrl: "https://ark.cn-beijing.volces.com/api/v3/images/generations",
  defaultModel: "doubao-seedream-4-5-251128",
  defaultSize: "2K",      // 文生图默认尺寸
  defaultEditSize: "2K",  // 图生图默认尺寸
  supportedModels: [
    "doubao-seedream-4-5-251128",
    "doubao-seedream-4-0-250828",
  ],
};

// Gitee（模力方舟）配置 - 支持同步 API 和图片编辑
export interface GiteeProviderConfig {
  apiUrl: string;           // 同步文生图 API
  editApiUrl: string;       // 同步图片编辑 API
  defaultModel: string;     // 文生图默认模型
  defaultEditModel: string; // 图片编辑默认模型
  defaultSize: string;      // 文生图默认尺寸
  defaultEditSize: string;  // 图生图默认尺寸
  supportedModels: string[];
  editModels: string[];     // 支持图片编辑的模型
}

export const GiteeConfig: GiteeProviderConfig = {
  apiUrl: "https://ai.gitee.com/v1/images/generations",
  editApiUrl: "https://ai.gitee.com/v1/images/edits",
  defaultModel: "z-image-turbo",
  defaultEditModel: "Qwen-Image-Edit",  // 通义千问图片编辑模型
  defaultSize: "2048x2048",     // 文生图默认尺寸
  defaultEditSize: "1024x1024", // 图生图默认尺寸
  supportedModels: [
    "z-image-turbo",
  ],
  editModels: [
    "Qwen-Image-Edit",  // 默认，支持图片合成/P图
    "HiDream-E1-Full",
    "FLUX.1-dev",
    "HelloMeme",
    "Kolors",
    "OmniConsistency",
  ],
};

// ModelScope（魔搭）配置
export const ModelScopeConfig: ProviderConfig = {
  apiUrl: "https://api-inference.modelscope.cn/v1",
  defaultModel: "Tongyi-MAI/Z-Image-Turbo",
  defaultSize: "2048x2048",      // 文生图默认尺寸
  defaultEditSize: "2048x2048",  // 图生图默认尺寸（暂不支持）
  supportedModels: [
    "Tongyi-MAI/Z-Image-Turbo",
  ],
};

// Hugging Face 配置 (使用 HF Spaces Gradio API，支持多 URL 故障转移)
export const HuggingFaceConfig: HuggingFaceProviderConfig = {
  // URL 资源池：当一个失败时自动切换到下一个
  apiUrls: [
    "https://luca115-z-image-turbo.hf.space",
    "https://mcp-tools-z-image-turbo.hf.space",
    "https://cpuai-z-image-turbo.hf.space",
    "https://victor-z-image-turbo-mcp.hf.space",
    "https://wavespeed-z-image-turbo.hf.space",
    "https://jinguotianxin-z-image-turbo.hf.space",
    "https://prithivmlmods-z-image-turbo-lora-dlc.hf.space",
    "https://linoyts-z-image-portrait.hf.space",
    "https://prokofyev8-z-image-portrait.hf.space",
    "https://ovi054-z-image-lora.hf.space",
    "https://yingzhac-z-image-nsfw.hf.space",
    "https://nymbo-tools.hf.space",
  ],
  defaultModel: "Qwen-Image-Edit-2511",
  defaultSize: "2048x2048",      // 文生图默认尺寸
  defaultEditSize: "2048x2048",  // 图生图默认尺寸（暂不支持）
  supportedModels: [
    "z-image-turbo",
    "Qwen-Image-Edit-2511",
  ],
};

// 统一超时时间：300秒（适用于所有渠道的 API 请求，给生图留足时间）
export const API_TIMEOUT_MS = 300000;

// 服务端口
export const PORT = parseInt(Deno.env.get("PORT") || "10001");
