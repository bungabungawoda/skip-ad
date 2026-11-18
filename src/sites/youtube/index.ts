import { defineSitePlugin } from "../../core/plugin/define";
import { parseSiteManifest } from "../../core/plugin/manifest";
import { createYouTubeAdapter } from "./adapter";
import rawManifest from "./site.json";

/**
 * YouTube 插件定义。contentMatches、hostPermissions 与能力只在 site.json 声明一次。
 */
export default defineSitePlugin(
  parseSiteManifest(rawManifest, "src/sites/youtube/site.json"),
  createYouTubeAdapter
);
