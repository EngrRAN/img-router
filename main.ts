// 多合一图像生成 API 中转服务
// 支持：火山引擎 (VolcEngine)、Gitee (模力方舟)、ModelScope (魔搭)、Hugging Face
// 路由策略：根据 API Key 格式自动分发

// ================= 导入日志模块 =================

import {
  configureLogger,
  initLogger,
  closeLogger,
  logRequestStart,
  logRequestEnd,
  logProviderRouting,
  logApiCallStart,
  logApiCallEnd,
  generateRequestId,
  info,
  warn,
  error,
  debug,
  LogLevel,
  // 增强日志函数
  logFullPrompt,
  logInputImages,
  logImageGenerationStart,
  logGeneratedImages,
  logImageGenerationComplete,
  logImageGenerationFailed,
} from "./logger.ts";

// ================= 配置常量 =================

import {
  VolcEngineConfig,
  GiteeConfig,
  ModelScopeConfig,
  HuggingFaceConfig,
  API_TIMEOUT_MS,
  PORT,
} from "./config.ts";

// ================= 类型定义 =================

type Provider = "VolcEngine" | "Gitee" | "ModelScope" | "HuggingFace" | "Unknown";

// 消息内容项类型
interface TextContentItem {
  type: "text";
  text: string;
}

interface ImageUrlContentItem {
  type: "image_url";
  image_url?: { url: string };
}

type MessageContentItem = TextContentItem | ImageUrlContentItem;

// 消息类型
interface Message {
  role: string;
  content: string | MessageContentItem[];
}

interface ChatRequest {
  model?: string;
  messages: Message[];
  stream?: boolean;
  size?: string;
  [key: string]: unknown;
}

// ================= 核心逻辑 =================

function detectProvider(apiKey: string): Provider {
  if (!apiKey) return "Unknown";

  // Hugging Face: hf_xxxx...
  if (apiKey.startsWith("hf_")) {
    logProviderRouting("HuggingFace", apiKey.substring(0, 4));
    return "HuggingFace";
  }

  if (apiKey.startsWith("ms-")) {
    logProviderRouting("ModelScope", apiKey.substring(0, 4));
    return "ModelScope";
  }

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRegex.test(apiKey)) {
    logProviderRouting("VolcEngine", apiKey.substring(0, 4));
    return "VolcEngine";
  }

  const giteeRegex = /^[a-zA-Z0-9]{30,60}$/;
  if (giteeRegex.test(apiKey)) {
    logProviderRouting("Gitee", apiKey.substring(0, 4));
    return "Gitee";
  }

  logProviderRouting("Unknown", apiKey.substring(0, 4));
  return "Unknown";
}

function extractPromptAndImages(messages: Message[]): { prompt: string; images: string[] } {
  let prompt = "";
  const currentImages: string[] = [];
  let lastUserIndex = -1;

  // 1. 提取最后一条用户消息的内容
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIndex = i;
      const userContent = messages[i].content;
      if (typeof userContent === "string") {
        prompt = userContent;
      } else if (Array.isArray(userContent)) {
        const textItem = userContent.find((item: MessageContentItem) => item.type === "text") as TextContentItem | undefined;
        prompt = textItem?.text || "";
        
        const imgs = userContent
          .filter((item: MessageContentItem): item is ImageUrlContentItem => item.type === "image_url")
          .map((item: ImageUrlContentItem) => item.image_url?.url || "")
          .filter(Boolean);
        currentImages.push(...imgs);
      }
      break;
    }
  }

  // 2. 追溯历史图片（实现上下文关联与多图融合）
  const historicalImages: string[] = [];
  if (lastUserIndex !== -1) {
    // 从当前消息的前一条开始向前找，找到最近的一个包含图片的对话块
    for (let i = lastUserIndex - 1; i >= 0; i--) {
      const content = messages[i].content;
      let foundInMsg: string[] = [];
      
      if (typeof content === "string") {
        // 匹配 Markdown 图片: ![alt](url) 或 ![alt](data:image/...)
        // 同时支持 URL 和 Base64 格式
        const matches = content.matchAll(/!\[.*?\]\(((?:https?:\/\/|data:image\/)[^\)]+)\)/g);
        for (const match of matches) {
          foundInMsg.push(match[1]);
        }
      } else if (Array.isArray(content)) {
        foundInMsg = content
          .filter((item: MessageContentItem): item is ImageUrlContentItem => item.type === "image_url")
          .map((item: ImageUrlContentItem) => item.image_url?.url || "")
          .filter(Boolean);
      }
      
      if (foundInMsg.length > 0) {
        historicalImages.push(...foundInMsg);
        debug("Router", `发现历史参考图: ${foundInMsg.length}张`);
        break; // 只取最近的一次图片上下文
      }
    }
  }

  // 3. 按照“本次图片优先，历史图片补充”的原则合并
  // 这样如果是 P 图场景，本次上传的“刺客”就是图1，历史的“美女”就是图2
  const finalImages = [...currentImages];
  for (const img of historicalImages) {
    if (!finalImages.includes(img)) {
      finalImages.push(img);
    }
  }

  return { prompt, images: finalImages };
}

// ================= 超时控制辅助函数 =================

/**
 * 带超时控制的 fetch 函数
 * @param url 请求 URL
 * @param options fetch 选项
 * @param timeoutMs 超时时间（毫秒），默认使用 API_TIMEOUT_MS
 * @returns Promise<Response>
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number = API_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ================= 辅助函数 =================

/**
 * 将图片 URL 下载并转换为 Base64 格式
 * @param url 图片 URL
 * @returns Base64 编码的图片数据（不含 data:image/xxx;base64, 前缀）
 */
async function urlToBase64(url: string): Promise<{ base64: string; mimeType: string }> {
  const response = await fetchWithTimeout(url, { method: "GET" });
  if (!response.ok) {
    throw new Error(`下载图片失败: ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const uint8Array = new Uint8Array(arrayBuffer);
  
  // 将二进制数据转换为 Base64
  let binary = "";
  for (let i = 0; i < uint8Array.length; i++) {
    binary += String.fromCharCode(uint8Array[i]);
  }
  const base64 = btoa(binary);
  
  // 获取 MIME 类型
  const contentType = response.headers.get("content-type") || "image/png";
  const mimeType = contentType.split(";")[0].trim();
  
  return { base64, mimeType };
}

// ================= 渠道处理函数 =================

/**
 * 火山引擎（豆包）图片生成处理函数
 *
 * 【文生图】纯文字生成图片
 *   - 默认尺寸：VolcEngineConfig.defaultSize (4096x4096)
 *   - 支持模型：doubao-seedream-4-0-250828, doubao-seedream-4-5-251128
 *
 * 【图生图】参考图片 + 文字生成图片
 *   - 默认尺寸：VolcEngineConfig.defaultEditSize (4096x4096)
 *   - 支持传入图片 URL 或 Base64
 *   - 图片会作为参考进行风格迁移或内容修改
 */
async function handleVolcEngine(
  apiKey: string,
  reqBody: ChatRequest,
  prompt: string,
  images: string[],
  requestId: string
): Promise<string> {
  const startTime = Date.now();
  const hasImages = images.length > 0;
  const apiType = hasImages ? "image_edit" : "generate_image";
  
  logApiCallStart("VolcEngine", apiType);
  
  // 记录完整 Prompt
  logFullPrompt("VolcEngine", requestId, prompt);
  
  // 记录输入图片（如果有）
  if (hasImages) {
    logInputImages("VolcEngine", requestId, images);
  }

  // 处理输入图片：默认转换为 Base64 格式以实现“永存”
  const processedImages = await Promise.all(images.map(async (img) => {
    if (img.startsWith("data:image/")) return img;
    if (img.startsWith("http")) {
      try {
        const { base64, mimeType } = await urlToBase64(img);
        return `data:${mimeType};base64,${base64}`;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        warn("VolcEngine", `图片下载并转换为 Base64 失败，回退到 URL: ${msg}`);
        return img;
      }
    }
    return img;
  }));
  
  // 使用配置中的默认模型，支持多模型
  const model = reqBody.model && VolcEngineConfig.supportedModels.includes(reqBody.model)
    ? reqBody.model
    : VolcEngineConfig.defaultModel;
  
  // 根据是否有输入图片选择不同的默认尺寸
  const size = reqBody.size || (hasImages ? VolcEngineConfig.defaultEditSize : VolcEngineConfig.defaultSize);
  
  // 记录生成开始
  logImageGenerationStart("VolcEngine", requestId, model, size, prompt.length);
  
  // 构建符合最新规范的请求体 (使用展开运算符避免 any 类型)
  const arkRequest = {
    model: model,
    prompt: prompt || "A beautiful scenery",
    // 默认使用 b64_json 以实现图片永存，保留 url 作为备用
    response_format: (reqBody["response_format"] as string) || "b64_json",
    size: size,
    watermark: false,
    // 根据图片数量动态添加参数
    ...(hasImages ? {
      image: processedImages.length === 1 ? processedImages[0] : processedImages,
      ...(processedImages.length > 1 ? { sequential_image_generation: "disabled" } : {})
    } : {})
  };

  const response = await fetchWithTimeout(VolcEngineConfig.apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "Connection": "close"
    },
    body: JSON.stringify(arkRequest),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const err = new Error(`VolcEngine API Error (${response.status}): ${errorText}`);
    logImageGenerationFailed("VolcEngine", requestId, errorText);
    logApiCallEnd("VolcEngine", "generate_image", false, Date.now() - startTime);
    throw err;
  }

  const data = await response.json();
  
  // 记录生成的图片 URL
  logGeneratedImages("VolcEngine", requestId, data.data || []);
  
  const duration = Date.now() - startTime;
  const imageData = data.data || [];
  const imageCount = imageData.length;
  logImageGenerationComplete("VolcEngine", requestId, imageCount, duration);
  
  // 智能处理返回结果：优先使用 Base64 嵌入以实现“永存”
  const result = imageData.map((img: { url?: string; b64_json?: string }) => {
    if (img.b64_json) {
      // 优先使用 Base64
      return `![Generated Image](data:image/png;base64,${img.b64_json})`;
    } else if (img.url) {
      // 备用使用 URL
      return `![Generated Image](${img.url})`;
    }
    return "";
  }).filter(Boolean).join("\n\n") || "图片生成失败";
  
  logApiCallEnd("VolcEngine", apiType, true, duration);
  return result;
}

/**
 * Gitee（模力方舟）图片生成处理函数
 *
 * 【文生图】纯文字生成图片
 *   - API：GiteeConfig.apiUrl (同步 API)
 *   - 默认尺寸：GiteeConfig.defaultSize (2048x2048)
 *   - 支持模型：Qwen-Image-Edit-2511
 *   - 返回格式：Base64 嵌入（永久有效）
 *
 * 【图生图】参考图片 + 文字生成图片
 *   - API：GiteeConfig.editApiUrl (同步图片编辑 API)
 *   - 默认尺寸：GiteeConfig.defaultEditSize (1024x1024)
 *   - 支持模型：Qwen-Image-Edit-2511
 *   - 输入格式：multipart/form-data，图片自动转换为 Base64
 *   - 返回格式：Base64 嵌入（永久有效）
 *   - 注意：图片编辑模型对尺寸有限制，仅支持 1024x1024
 */
async function handleGitee(
  apiKey: string,
  reqBody: ChatRequest,
  prompt: string,
  images: string[],
  requestId: string
): Promise<string> {
  const startTime = Date.now();
  const hasImages = images.length > 0;
  const apiType = hasImages ? "image_edit" : "generate_image";
  
  logApiCallStart("Gitee", apiType);
  logFullPrompt("Gitee", requestId, prompt);
  
  if (hasImages) {
    logInputImages("Gitee", requestId, images);
  }

  // 文生图和图生图使用不同的默认尺寸
  const size = reqBody.size || (hasImages ? GiteeConfig.defaultEditSize : GiteeConfig.defaultSize);

  if (hasImages) {
    // ========== 图片编辑模式（同步 API）==========
    // 选择编辑模型
    const model = reqBody.model && GiteeConfig.editModels.includes(reqBody.model)
      ? reqBody.model
      : GiteeConfig.editModels[0]; // 默认使用第一个编辑模型
    
    logImageGenerationStart("Gitee", requestId, model, size, prompt.length);
    info("Gitee", `使用图片编辑模式, 模型: ${model}`);

    // 处理图片输入：统一转换为 Base64 格式
    const imageInput = images[0];
    let base64Data: string;
    let mimeType: string;
    
    if (imageInput.startsWith("data:image/")) {
      // 已经是 Base64 格式，直接提取
      base64Data = imageInput.split(",")[1];
      mimeType = imageInput.split(";")[0].split(":")[1];
      info("Gitee", "输入图片已是 Base64 格式");
    } else {
      // URL 格式：下载并转换为 Base64
      info("Gitee", `正在下载图片并转换为 Base64: ${imageInput.substring(0, 50)}...`);
      const downloaded = await urlToBase64(imageInput);
      base64Data = downloaded.base64;
      mimeType = downloaded.mimeType;
      info("Gitee", `图片下载完成, MIME: ${mimeType}, 大小: ${Math.round(base64Data.length / 1024)}KB`);
    }

    // 将 Base64 转换为 Blob
    const binaryData = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
    const blob = new Blob([binaryData], { type: mimeType });

    // 构建 multipart/form-data 请求
    const formData = new FormData();
    formData.append("model", model);
    formData.append("prompt", prompt || "");
    formData.append("size", GiteeConfig.defaultEditSize); // 使用配置中的图生图尺寸
    formData.append("n", "1");
    formData.append("response_format", "b64_json"); // 使用 Base64 返回
    formData.append("image", blob, "image.png");

    debug("Gitee", `发送图片编辑请求到: ${GiteeConfig.editApiUrl}`);

    const response = await fetchWithTimeout(GiteeConfig.editApiUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      const err = new Error(`Gitee Edit API Error (${response.status}): ${errorText}`);
      error("Gitee", `图片编辑 API 错误: ${response.status}`);
      logImageGenerationFailed("Gitee", requestId, errorText);
      logApiCallEnd("Gitee", apiType, false, Date.now() - startTime);
      throw err;
    }

    // 同步 API 直接返回结果
    const data = await response.json();
    const imageData = data.data || [];
    
    if (!imageData || imageData.length === 0) {
      throw new Error("Gitee 返回数据为空");
    }

    logGeneratedImages("Gitee", requestId, imageData);
    
    const duration = Date.now() - startTime;
    logImageGenerationComplete("Gitee", requestId, imageData.length, duration);

    // 构建返回结果（优先使用 Base64 嵌入）
    const results = imageData.map((img: { url?: string; b64_json?: string }) => {
      if (img.b64_json) {
        return `![Generated Image](data:image/png;base64,${img.b64_json})`;
      } else if (img.url) {
        return `![Generated Image](${img.url})`;
      }
      return "";
    }).filter(Boolean);

    logApiCallEnd("Gitee", apiType, true, duration);
    return results.join("\n\n") || "图片生成失败";
    
  } else {
    // ========== 文生图模式（同步 API）==========
    const model = reqBody.model && GiteeConfig.supportedModels.includes(reqBody.model)
      ? reqBody.model
      : GiteeConfig.defaultModel;
    
    logImageGenerationStart("Gitee", requestId, model, size, prompt.length);
    info("Gitee", `使用文生图模式, 模型: ${model}`);

    const giteeRequest = {
      model: model,
      prompt: prompt || "A beautiful scenery",
      size: size,
      n: 1,
      response_format: "b64_json" // 使用 Base64 返回
    };

    debug("Gitee", `发送文生图请求到: ${GiteeConfig.apiUrl}`);

    const response = await fetchWithTimeout(GiteeConfig.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify(giteeRequest),
    });

    if (!response.ok) {
      const errorText = await response.text();
      const err = new Error(`Gitee API Error (${response.status}): ${errorText}`);
      error("Gitee", `文生图 API 错误: ${response.status}`);
      logImageGenerationFailed("Gitee", requestId, errorText);
      logApiCallEnd("Gitee", apiType, false, Date.now() - startTime);
      throw err;
    }

    // 同步 API 直接返回结果
    const data = await response.json();
    const imageData = data.data || [];
    
    if (!imageData || imageData.length === 0) {
      throw new Error("Gitee 返回数据为空");
    }

    logGeneratedImages("Gitee", requestId, imageData);
    
    const duration = Date.now() - startTime;
    logImageGenerationComplete("Gitee", requestId, imageData.length, duration);

    // 构建返回结果（优先使用 Base64 嵌入）
    const results = imageData.map((img: { url?: string; b64_json?: string }) => {
      if (img.b64_json) {
        return `![Generated Image](data:image/png;base64,${img.b64_json})`;
      } else if (img.url) {
        return `![Generated Image](${img.url})`;
      }
      return "";
    }).filter(Boolean);

    logApiCallEnd("Gitee", apiType, true, duration);
    return results.join("\n\n") || "图片生成失败";
  }
}

/**
 * ModelScope（魔搭）图片生成处理函数
 *
 * 【文生图】纯文字生成图片
 *   - API：异步任务模式（提交 + 轮询）
 *   - 默认尺寸：ModelScopeConfig.defaultSize (2048x2048)
 *   - 支持模型：Tongyi-MAI/Z-Image-Turbo
 *   - 返回格式：图片 URL
 *
 * 【图生图】暂不支持
 *   - ModelScope 当前配置的模型不支持图片编辑
 *   - defaultEditSize 预留配置，待后续支持
 */
async function handleModelScope(
  apiKey: string,
  reqBody: ChatRequest,
  prompt: string,
  requestId: string
): Promise<string> {
  const startTime = Date.now();
  logApiCallStart("ModelScope", "generate_image");

  // 记录完整 Prompt
  logFullPrompt("ModelScope", requestId, prompt);
  
  // 使用配置中的默认模型，支持多模型
  const model = reqBody.model && ModelScopeConfig.supportedModels.includes(reqBody.model)
    ? reqBody.model
    : ModelScopeConfig.defaultModel;
  
  // 文生图默认尺寸（ModelScope 暂不支持图生图）
  const size = reqBody.size || ModelScopeConfig.defaultSize;
  
  // 记录生成开始
  logImageGenerationStart("ModelScope", requestId, model, size, prompt.length);

  const submitResponse = await fetchWithTimeout(`${ModelScopeConfig.apiUrl}/images/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "X-ModelScope-Async-Mode": "true"
    },
    body: JSON.stringify({
      model: model,
      prompt: prompt || "A beautiful scenery",
      size: size,
      n: 1
    }),
  });

  if (!submitResponse.ok) {
    const errorText = await submitResponse.text();
    const err = new Error(`ModelScope Submit Error (${submitResponse.status}): ${errorText}`);
    logImageGenerationFailed("ModelScope", requestId, errorText);
    logApiCallEnd("ModelScope", "generate_image", false, Date.now() - startTime);
    throw err;
  }

  const submitData = await submitResponse.json();
  const taskId = submitData.task_id;
  info("ModelScope", `任务已提交, Task ID: ${taskId}`);

  const maxAttempts = 60;
  let pollingAttempts = 0;
  
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    pollingAttempts++;

    const checkResponse = await fetchWithTimeout(`${ModelScopeConfig.apiUrl}/tasks/${taskId}`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "X-ModelScope-Task-Type": "image_generation"
      }
    });

    if (!checkResponse.ok) {
      warn("ModelScope", `轮询警告: ${checkResponse.status}`);
      continue;
    }

    const checkData = await checkResponse.json();
    const status = checkData.task_status;

    if (status === "SUCCEED") {
      const imageUrls = checkData.output_images || [];
      
      // 记录生成的图片 URL
      const imageData = imageUrls.map((url: string) => ({ url }));
      logGeneratedImages("ModelScope", requestId, imageData);
      
      const duration = Date.now() - startTime;
      const imageCount = imageUrls.length;
      logImageGenerationComplete("ModelScope", requestId, imageCount, duration);
      
      const result = imageUrls.map((url: string) => `![Generated Image](${url})`).join("\n\n") || "图片生成失败";
      
      info("ModelScope", `任务成功完成, 耗时: ${pollingAttempts}次轮询`);
      logApiCallEnd("ModelScope", "generate_image", true, duration);
      return result;
    } else if (status === "FAILED") {
      const err = new Error(`ModelScope Task Failed: ${JSON.stringify(checkData)}`);
      error("ModelScope", "任务失败");
      logImageGenerationFailed("ModelScope", requestId, JSON.stringify(checkData));
      logApiCallEnd("ModelScope", "generate_image", false, Date.now() - startTime);
      throw err;
    } else {
      debug("ModelScope", `状态: ${status} (第${i + 1}次)`);
    }
  }

  const err = new Error("ModelScope Task Timeout");
  error("ModelScope", "任务超时");
  logImageGenerationFailed("ModelScope", requestId, "任务超时");
  logApiCallEnd("ModelScope", "generate_image", false, Date.now() - startTime);
  throw err;
}

/**
 * HuggingFace 图片生成处理函数
 *
 * 【文生图】纯文字生成图片
 *   - API：Gradio API（HF Spaces）
 *   - 默认尺寸：HuggingFaceConfig.defaultSize (2048x2048)
 *   - 支持模型：z-image-turbo, Qwen-Image-Edit-2511
 *   - 返回格式：图片 URL
 *   - 特性：支持多 URL 故障转移，自动切换备用节点
 *
 * 【图生图】暂不支持
 *   - 当前 Gradio API 配置不支持图片输入
 *   - 如果传入图片会被忽略并给出警告
 *   - defaultEditSize 预留配置，待后续支持
 */
async function handleHuggingFace(
  apiKey: string,
  reqBody: ChatRequest,
  prompt: string,
  images: string[],
  requestId: string
): Promise<string> {
  const startTime = Date.now();
  logApiCallStart("HuggingFace", "generate_image");

  // 记录完整 Prompt
  logFullPrompt("HuggingFace", requestId, prompt);
  
  // 记录输入图片（如果有，会被忽略）
  if (images.length > 0) {
    logInputImages("HuggingFace", requestId, images);
  }
  
  // 使用配置中的默认模型
  const model = reqBody.model && HuggingFaceConfig.supportedModels.includes(reqBody.model)
    ? reqBody.model
    : HuggingFaceConfig.defaultModel;
  
  // 文生图默认尺寸（HuggingFace 暂不支持图生图）
  const size = reqBody.size || HuggingFaceConfig.defaultSize;
  const [width, height] = size.split('x').map(Number);
  const seed = Math.round(Math.random() * 2147483647);
  const steps = 9;

  // 记录生成开始
  logImageGenerationStart("HuggingFace", requestId, model, size, prompt.length);

  if (images.length > 0) {
    warn("HuggingFace", "Hugging Face 渠道暂不支持多图参考，将忽略输入图片");
  }

  // 使用 Gradio API 格式
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  // 准备请求体数据
  const requestBody = JSON.stringify({
    data: [prompt || "A beautiful scenery", height || 1024, width || 1024, steps, seed, false]
  });

  // 获取配置中的 URL 资源池（支持故障转移）
  const apiUrls = HuggingFaceConfig.apiUrls;
  
  if (!apiUrls || apiUrls.length === 0) {
    const err = new Error("HuggingFace 配置错误: 未配置任何 API URL");
    error("HuggingFace", "API URL 资源池为空");
    logImageGenerationFailed("HuggingFace", requestId, "配置错误");
    logApiCallEnd("HuggingFace", "generate_image", false, Date.now() - startTime);
    throw err;
  }

  info("HuggingFace", `开始处理请求，URL 资源池大小: ${apiUrls.length}`);

  // 遍历所有 URL，尝试执行请求
  let lastError: Error | null = null;
  
  for (let i = 0; i < apiUrls.length; i++) {
    const apiUrl = apiUrls[i];
    const isLastAttempt = i === apiUrls.length - 1;
    
    info("HuggingFace", `尝试 URL [${i + 1}/${apiUrls.length}]: ${apiUrl}`);
    
    try {
      // 步骤1: 提交任务到队列
      const queueResponse = await fetchWithTimeout(`${apiUrl}/gradio_api/call/generate_image`, {
        method: "POST",
        headers,
        body: requestBody,
      });

      if (!queueResponse.ok) {
        const errorText = await queueResponse.text();
        throw new Error(`API Error (${queueResponse.status}): ${errorText}`);
      }

      const { event_id } = await queueResponse.json();
      info("HuggingFace", `任务已提交成功, Event ID: ${event_id}`);

      // 步骤2: 获取结果 (SSE 流)
      const resultResponse = await fetchWithTimeout(`${apiUrl}/gradio_api/call/generate_image/${event_id}`, {
        method: "GET",
        headers,
      });

      if (!resultResponse.ok) {
        const errorText = await resultResponse.text();
        throw new Error(`Result API Error (${resultResponse.status}): ${errorText}`);
      }

      const sseText = await resultResponse.text();
      
      // 解析 SSE 流，提取 complete 事件的数据
      const imageUrl = extractImageUrlFromSSE(sseText);
      
      if (!imageUrl) {
        throw new Error("返回数据格式异常：未能从 SSE 流中提取图片 URL");
      }

      // 成功获取图片！
      logGeneratedImages("HuggingFace", requestId, [{ url: imageUrl }]);
      const duration = Date.now() - startTime;
      logImageGenerationComplete("HuggingFace", requestId, 1, duration);
      
      info("HuggingFace", `✅ 成功使用 URL: ${apiUrl}`);
      
      const result = `![Generated Image](${imageUrl})`;
      logApiCallEnd("HuggingFace", "generate_image", true, duration);
      return result;

    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      error("HuggingFace", `❌ URL [${apiUrl}] 失败: ${lastError.message}`);
      
      // 如果还有更多 URL，提示即将切换
      if (!isLastAttempt) {
        info("HuggingFace", `🔄 正在切换到下一个 URL...`);
      }
      // 如果是最后一个 URL，抛出错误
    }
  }

  // 所有 URL 都尝试完毕，仍然失败
  const err = lastError || new Error("所有 HuggingFace URL 均失败");
  error("HuggingFace", `💥 所有 URL 均失败: ${err.message}`);
  logImageGenerationFailed("HuggingFace", requestId, `所有 URL 均失败: ${err.message}`);
  logApiCallEnd("HuggingFace", "generate_image", false, Date.now() - startTime);
  throw err;
}

// 从 SSE 流中提取图片 URL
function extractImageUrlFromSSE(sseStream: string): string | null {
  const lines = sseStream.split('\n');
  let isCompleteEvent = false;

  for (const line of lines) {
    if (line.startsWith('event:')) {
      const eventType = line.substring(6).trim();
      if (eventType === 'complete') {
        isCompleteEvent = true;
      } else if (eventType === 'error') {
        throw new Error("HuggingFace API 返回错误");
      } else {
        isCompleteEvent = false;
      }
    } else if (line.startsWith('data:') && isCompleteEvent) {
      const jsonData = line.substring(5).trim();
      try {
        const data = JSON.parse(jsonData);
        // data[0] 应该是图片对象 { url: "..." }
        if (data && data[0] && data[0].url) {
          return data[0].url;
        }
      } catch (e) {
        error("HuggingFace", `解析 SSE 数据失败: ${e}`);
      }
    }
  }
  return null;
}

// ================= 主处理函数 =================

async function handleChatCompletions(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const requestId = generateRequestId();

  logRequestStart(req, requestId);

  // 基础路径健康检查 (用于 Docker healthcheck)
  if (url.pathname === "/" || url.pathname === "/health") {
    return new Response(JSON.stringify({ status: "ok", service: "img-router" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  if (url.pathname !== "/v1/chat/completions") {
    warn("HTTP", `路由不匹配: ${url.pathname}`);
    await logRequestEnd(requestId, req.method, url.pathname, 404, 0);
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  }

  const authHeader = req.headers.get("Authorization");
  const apiKey = authHeader?.replace("Bearer ", "").trim();
  
  if (!apiKey) {
    warn("HTTP", "Authorization header 缺失");
    await logRequestEnd(requestId, req.method, url.pathname, 401, 0, "missing auth");
    return new Response(JSON.stringify({ error: "Authorization header missing" }), { 
      status: 401, 
      headers: { "Content-Type": "application/json" } 
    });
  }

  const provider = detectProvider(apiKey);
  if (provider === "Unknown") {
    warn("HTTP", "API Key 格式无法识别");
    await logRequestEnd(requestId, req.method, url.pathname, 401, 0, "invalid key");
    return new Response(JSON.stringify({ error: "Invalid API Key format. Could not detect provider." }), { 
      status: 401, 
      headers: { "Content-Type": "application/json" } 
    });
  }

  info("HTTP", `路由到 ${provider}`);

  try {
    const requestBody: ChatRequest = await req.json();
    const isStream = requestBody.stream === true;
    const { prompt, images } = extractPromptAndImages(requestBody.messages || []);

    // 记录完整 Prompt（DEBUG 级别只记录摘要）
    debug("Router", `提取 Prompt: ${prompt?.substring(0, 80)}... (完整长度: ${prompt?.length || 0})`);

    let imageContent = "";
    
    switch (provider) {
      case "VolcEngine":
        imageContent = await handleVolcEngine(apiKey, requestBody, prompt, images, requestId);
        break;
      case "Gitee":
        imageContent = await handleGitee(apiKey, requestBody, prompt, images, requestId);
        break;
      case "ModelScope":
        imageContent = await handleModelScope(apiKey, requestBody, prompt, requestId);
        break;
      case "HuggingFace":
        imageContent = await handleHuggingFace(apiKey, requestBody, prompt, images, requestId);
        break;
    }

    const responseId = `chatcmpl-${crypto.randomUUID()}`;
    const modelName = requestBody.model || "unknown-model";
    const startTime = Date.now();

    if (isStream) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          const contentChunk = {
            id: responseId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: modelName,
            choices: [{
              index: 0,
              delta: { role: "assistant", content: imageContent },
              finish_reason: null
            }]
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(contentChunk)}\n\n`));

          const endChunk = {
            id: responseId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: modelName,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: "stop"
            }]
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`));
          controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
          controller.close();
        }
      });

      info("HTTP", `响应完成 (流式)`);
      await logRequestEnd(requestId, req.method, url.pathname, 200, Date.now() - startTime);
      
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
        }
      });
    }

    const responseBody = JSON.stringify({
      id: responseId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: modelName,
      choices: [{
        index: 0,
        message: { role: "assistant", content: imageContent },
        finish_reason: "stop"
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    });

    info("HTTP", `响应完成 (JSON)`);
    await logRequestEnd(requestId, req.method, url.pathname, 200, Date.now() - startTime);

    return new Response(responseBody, {
      headers: { 
        "Content-Type": "application/json", 
        "Access-Control-Allow-Origin": "*" 
      }
    });

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Internal Server Error";
    const errorProvider = provider || "Unknown";
    
    error("Proxy", `请求处理错误 (${errorProvider}): ${errorMessage}`);
    await logRequestEnd(requestId, req.method, url.pathname, 500, 0, errorMessage);
    
    return new Response(JSON.stringify({ 
      error: { message: errorMessage, type: "server_error", provider: errorProvider } 
    }), { 
      status: 500, 
      headers: { "Content-Type": "application/json" } 
    });
  }
}

// ================= 启动服务 =================

// 读取版本号
async function getVersion(): Promise<string> {
  try {
    const denoJson = await Deno.readTextFile("./deno.json");
    const config = JSON.parse(denoJson);
    return config.version || "unknown";
  } catch {
    return "unknown";
  }
}

await initLogger();

const logLevel = Deno.env.get("LOG_LEVEL")?.toUpperCase();
if (logLevel && logLevel in LogLevel) {
  configureLogger({ level: LogLevel[logLevel as keyof typeof LogLevel] });
}

const version = await getVersion();
info("Startup", `🚀 服务启动端口 ${PORT}`);
info("Startup", `📦 版本: ${version}`);
info("Startup", "🔧 支持: 火山引擎, Gitee, ModelScope, HuggingFace");
info("Startup", `📁 日志目录: ./data/logs`);

Deno.addSignalListener("SIGINT", async () => {
  info("Startup", "收到 SIGINT, 关闭服务...");
  await closeLogger();
  Deno.exit(0);
});

Deno.addSignalListener("SIGTERM", async () => {
  info("Startup", "收到 SIGTERM, 关闭服务...");
  await closeLogger();
  Deno.exit(0);
});

Deno.serve({ port: PORT }, (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
      }
    });
  }

  if (req.method !== "POST") {
    warn("HTTP", `不支持 ${req.method}`);
    return new Response("Method Not Allowed", { status: 405 });
  }

  return handleChatCompletions(req);
});
