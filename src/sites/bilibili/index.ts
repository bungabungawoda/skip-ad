import { defineSitePlugin } from "../../core/plugin/define";
import { parseSiteManifest } from "../../core/plugin/manifest";
import { createBilibiliAdapter } from "./adapter";
import rawManifest from "./site.json";

/**
 * 哔哩哔哩插件定义。contentMatches、hostPermissions 与能力只在 site.json 声明一次，
 * 运行时页面匹配与 Options 渲染都读这份声明。
 */
export default defineSitePlugin(
  parseSiteManifest(rawManifest, "src/sites/bilibili/site.json"),
  createBilibiliAdapter
);
