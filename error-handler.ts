// 通用错误处理模块 - 为所有图片生成提供商提供友好的错误信息

/**
 * 错误类型定义
 */
export enum ErrorType {
  /** 内容审核失败 */
  MODERATION_BLOCKED = "moderation_blocked",
  /** 请求参数错误 */
  BAD_REQUEST = "bad_request",
  /** 服务器内部错误 */
  INTERNAL_ERROR = "internal_error",
  /** 超时错误 */
  TIMEOUT = "timeout",
  /** API Key 不可用 */
  NO_AVAILABLE_KEY = "no_available_key",
  /** 未知错误 */
  UNKNOWN = "unknown",
}

/**
 * 错误关键词匹配规则
 */
const ERROR_PATTERNS = {
  // 内容审核相关关键词
  moderation: [
    "moderation_blocked",
    "moderation",
    "safety system",
    "safety_violations",
    "rejected by the safety",
    "cannot fulfill this request",
    "inappropriate content",
    "不当内容",
    "审核",
    "敏感内容",
  ],
  
  // 参数错误相关关键词
  badRequest: [
    "bad request",
    "invalid parameter",
    "invalid input",
    "参数错误",
    "格式错误",
  ],
  
  // 超时相关关键词
  timeout: [
    "timeout",
    "timed out",
    "超时",
  ],
  
  // API Key 不可用相关关键词
  noAvailableKey: [
    "no available sub-groups",
    "no available key",
    "没有可用的key",
    "key不可用",
    "密钥不可用",
  ],
  
  // 数据库错误相关关键词
  databaseError: [
    "failed query",
    "database error",
    "db error",
    "query failed",
    "数据库错误",
    "查询失败",
  ],
};

/**
 * 友好的错误提示信息
 */
const FRIENDLY_MESSAGES = {
  [ErrorType.MODERATION_BLOCKED]: "内容审核失败：您的请求因包含不当或敏感内容被安全系统拒绝。请修改提示词后重试。",
  [ErrorType.BAD_REQUEST]: "请求参数错误：请检查提示词或图片格式是否正确。",
  [ErrorType.INTERNAL_ERROR]: "服务提供商内部错误：服务暂时不可用，请稍后重试或更换其他模型。",
  [ErrorType.TIMEOUT]: "请求超时：服务器响应时间过长，请稍后重试。",
  [ErrorType.NO_AVAILABLE_KEY]: "API Key 不可用：当前没有可用的 API 密钥，请检查配置或稍后重试。",
  [ErrorType.UNKNOWN]: "图片生成失败：未知错误，请稍后重试。",
};

/**
 * 检测错误文本中是否包含特定关键词
 */
function containsKeywords(text: string, keywords: string[]): boolean {
  const lowerText = text.toLowerCase();
  return keywords.some(keyword => lowerText.includes(keyword.toLowerCase()));
}

/**
 * 识别错误类型
 */
function identifyErrorType(errorText: string, statusCode?: number): ErrorType {
  // 优先检查 API Key 不可用错误（特定错误优先级最高）
  if (containsKeywords(errorText, ERROR_PATTERNS.noAvailableKey)) {
    return ErrorType.NO_AVAILABLE_KEY;
  }
  
  // 检查数据库错误（Pollinations 等服务的数据库问题）
  if (containsKeywords(errorText, ERROR_PATTERNS.databaseError)) {
    return ErrorType.INTERNAL_ERROR;
  }
  
  // 检查内容审核错误
  if (containsKeywords(errorText, ERROR_PATTERNS.moderation)) {
    return ErrorType.MODERATION_BLOCKED;
  }
  
  // 检查超时错误
  if (containsKeywords(errorText, ERROR_PATTERNS.timeout)) {
    return ErrorType.TIMEOUT;
  }
  
  // 检查参数错误
  if (containsKeywords(errorText, ERROR_PATTERNS.badRequest)) {
    return ErrorType.BAD_REQUEST;
  }
  
  // 根据 HTTP 状态码判断
  if (statusCode) {
    if (statusCode === 400) {
      return ErrorType.BAD_REQUEST;
    } else if (statusCode === 500 || statusCode === 502) {
      return ErrorType.INTERNAL_ERROR;
    } else if (statusCode === 503) {
      // 503 状态码特殊处理：如果错误信息包含 key 相关关键词，返回 NO_AVAILABLE_KEY
      // 否则返回通用的 INTERNAL_ERROR
      if (containsKeywords(errorText, ERROR_PATTERNS.noAvailableKey)) {
        return ErrorType.NO_AVAILABLE_KEY;
      }
      return ErrorType.INTERNAL_ERROR;
    } else if (statusCode === 408 || statusCode === 504) {
      return ErrorType.TIMEOUT;
    }
  }
  
  return ErrorType.UNKNOWN;
}

/**
 * 解析并美化错误信息
 *
 * @param errorText - 原始错误文本（可能是 JSON 字符串或纯文本）
 * @param statusCode - HTTP 状态码（可选）
 * @param provider - 提供商名称（可选，用于日志）
 * @returns 友好的错误提示信息（保证简短，适合界面显示）
 */
export function parseErrorMessage(
  errorText: string,
  statusCode?: number,
  provider?: string
): string {
  // 🔧 第一步：提取核心错误信息（移除所有堆栈跟踪和路径）
  let parsedError: string = errorText;
  
  // 特殊处理：截断超长 URL（特别是包含 Base64 的 URL）
  parsedError = parsedError.replace(/https?:\/\/[^\s]+data%3Aimage[^\s]{100,}/gi, 'https://[图片URL过长已截断]');
  parsedError = parsedError.replace(/https?:\/\/[^\s]{200,}/gi, 'https://[URL过长已截断]');
  
  // 立即清理堆栈跟踪和文件路径（在解析 JSON 之前）
  parsedError = parsedError.replace(/\s+at\s+[^\n]+/g, ''); // 移除 "at xxx" 堆栈行
  parsedError = parsedError.replace(/\\n\s+at\s+.*/g, ''); // 移除转义的堆栈行
  parsedError = parsedError.replace(/\n\s+at\s+.*/g, ''); // 移除换行的堆栈行
  parsedError = parsedError.replace(/file:\/\/\/[^\s)]+/gi, ''); // 移除 file:/// 路径
  parsedError = parsedError.replace(/[A-Z]:\\[^\s)]+/g, ''); // 移除 Windows 路径
  parsedError = parsedError.replace(/\/[^\s]+\.(ts|js|json)/g, ''); // 移除 Unix 路径
  
  // 🔧 第二步：尝试从 JSON 中提取核心错误消息
  try {
    const errorData = JSON.parse(parsedError);
    
    // 尝试提取嵌套的错误信息
    if (errorData.error?.message) {
      try {
        const innerError = JSON.parse(errorData.error.message);
        parsedError = innerError.message || innerError.error?.message || errorData.error.message;
      } catch {
        parsedError = errorData.error.message;
      }
    } else if (errorData.message) {
      parsedError = errorData.message;
    } else if (errorData.error) {
      parsedError = typeof errorData.error === "string"
        ? errorData.error
        : JSON.stringify(errorData.error);
    }
  } catch {
    // 不是 JSON 格式，使用已清理的文本
  }
  
  // 🔧 第三步：再次清理（防止 JSON 内部还有堆栈信息）
  parsedError = parsedError.replace(/\s+at\s+[^\n]+/g, '');
  parsedError = parsedError.replace(/file:\/\/\/[^\s)]+/gi, '');
  parsedError = parsedError.replace(/[A-Z]:\\[^\s)]+/g, '');
  
  // 🔧 第四步：强制限制长度（最多 60 字符，确保界面不会超长）
  if (parsedError.length > 60) {
    // 尝试提取关键错误信息
    const errorMatch = parsedError.match(/"message":\s*"([^"]{0,50})/);
    if (errorMatch && errorMatch[1]) {
      parsedError = errorMatch[1];
    } else {
      // 直接截断
      parsedError = parsedError.substring(0, 50).trim();
    }
  }
  
  // 🔧 第五步：识别错误类型并返回友好消息
  const errorType = identifyErrorType(parsedError, statusCode);
  let friendlyMessage = FRIENDLY_MESSAGES[errorType];
  
  // 添加提供商标识
  if (provider) {
    friendlyMessage = `[${provider}] ${friendlyMessage}`;
  }
  
  // ⚠️ 关键：对于所有错误类型，都不再附加详细信息
  // 友好消息本身已经足够清晰，不需要技术细节
  return friendlyMessage;
}

/**
 * 为特定提供商创建错误处理函数
 * 
 * @param provider - 提供商名称
 * @returns 错误处理函数
 */
export function createErrorHandler(provider: string) {
  return (statusCode: number, errorText: string): string => {
    return parseErrorMessage(errorText, statusCode, provider);
  };
}