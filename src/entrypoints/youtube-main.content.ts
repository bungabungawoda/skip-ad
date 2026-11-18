import { defineContentScript } from "wxt/utils/define-content-script";
import site from "../sites/youtube/site.json";
import { installPlayerBridge } from "../sites/youtube/player-bridge-main";

/**
 * YouTube 播放器桥的 MAIN 世界入口。
 *
 * 内容脚本默认在隔离世界，读不到页面 JS 挂在 ytd-app / 播放器上的当前响应；
 * 这个入口只安装一个只读监听器，把当前视频的播放器数据回给隔离世界。
 * 页面匹配与 site.json 共用一份，避免两处维护。
 */
export default defineContentScript({
  world: "MAIN",
  matches: site.contentMatches,
  runAt: "document_idle",
  main() {
    installPlayerBridge();
  }
});
