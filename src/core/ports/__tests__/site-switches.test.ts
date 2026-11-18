import { describe, expect, it } from "vitest";
import { createMemoryStorageArea } from "../../../../tests/helpers/memory-storage";
import { readSiteSwitches, writeSiteSwitches } from "../site-switches";

describe("站点开关", () => {
  it("按字段补丁保存时保留另一个设置页已改的开关", async () => {
    const area = createMemoryStorageArea();
    await writeSiteSwitches(area, { youtube: { platformAdSkip: false } });
    await writeSiteSwitches(area, { youtube: { segmentAnalysis: false } });
    await expect(readSiteSwitches(area)).resolves.toMatchObject({
      youtube: { enabled: true, platformAdSkip: false, segmentAnalysis: false }
    });
  });
});
