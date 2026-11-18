/** 片段短于这个长度不作为广告：一句过渡语、换气或字幕误差都不该变成一次跳转。 */
export const MIN_SEGMENT_SECONDS = 3;

/** 一次发给模型的正文预算；切块与证据包共用，避免两处口径漂移。 */
export const CHUNK_CHARS_DEFAULT = 6_000;

/** 同类型片段之间小于这个间隔时按同一段推广处理。 */
export const SEGMENT_GAP_SECONDS = 1.5;
