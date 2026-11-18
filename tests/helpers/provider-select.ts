import { act } from "react";

async function settle(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

function providerTrigger(root?: HTMLElement | null): HTMLButtonElement {
  const trigger =
    root?.querySelector<HTMLButtonElement>("#provider") ??
    document.querySelector<HTMLButtonElement>("#provider");
  if (!trigger) throw new Error("provider trigger not found");
  return trigger;
}

export async function openProviderList(root?: HTMLElement | null): Promise<void> {
  const trigger = providerTrigger(root);
  await act(async () => {
    trigger.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })
    );
    await settle();
  });
}

export async function chooseProvider(
  id: string,
  root?: HTMLElement | null
): Promise<void> {
  await openProviderList(root);
  const option = document.querySelector<HTMLElement>(`[data-provider-id="${id}"]`);
  if (!option) throw new Error(`provider option ${id} not found`);
  await act(async () => {
    option.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, button: 0, pointerType: "mouse" })
    );
    option.click();
    await settle();
  });
}
