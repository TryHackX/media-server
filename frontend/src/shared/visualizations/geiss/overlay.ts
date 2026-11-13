import { el } from "../../dom";
import { t } from "../../i18n";
import { icon } from "../../icons";
import { MESSAGE_LENGTH, MESSAGE_SLOTS, messageText } from "./messages";
import { freeSlot, PRESET_SLOTS, slotName } from "./presets";
import type { GeissPreset } from "./sim";

/** What the box asks of the adapter (geiss/index.ts). */
export interface GeissBoxHost {
  /** The saved presets by slot. */
  presets(): ReadonlyMap<number, GeissPreset>;
  /** The slot whose preset is on screen (pinned), or null. */
  shown(): number | null;
  /** "5. Superperspektywa": the map a preset holds. */
  mapName(preset: GeissPreset): string;
  /** `]##`: the map on screen into `slot`; false when there is nothing to save or nowhere to keep it. */
  save(slot: number): boolean;
  /** `[##`: the slot's preset on screen, and kept there. */
  load(slot: number): void;
  remove(slot: number): void;
  /** The saved messages by slot, as GEISS.INI holds them. */
  messages(): ReadonlyMap<number, string>;
  /** MESSAGE ## of [CUSTOM MESSAGES] set to `value`; false when it could not be kept. */
  saveMessage(slot: number, value: string): boolean;
  removeMessage(slot: number): void;
  /** `m##`: the slot's message popped up over the picture. */
  showMessage(slot: number): void;
  /** "Don't base the wave colors on the music", unticked: on or off. */
  syncColour(): boolean;
  setSyncColour(on: boolean): void;
}

/** How long "Usuń" waits for its second press, and a message stays. */
const CONFIRM_MS = 4000;

type Tab = "presets" | "messages";

/**
 * Geiss's GEISS.INI over the picture, bottom right: a button that opens a small box with two tabs —
 * the presets ("save the map on screen to slot ##" and the saved slots, each with "load" and
 * "delete") and the custom messages (write message ## of [CUSTOM MESSAGES], show one, edit,
 * delete) — and under them the wave colours' option of Geiss's config panel. Deleting asks twice.
 * It is `.visualizer-panel__overlay`: it rests with the toolbar.
 */
export function geissBox(host: GeissBoxHost): { element: HTMLElement; refresh(): void } {
  const id = `geiss-box-${Math.random().toString(36).slice(2, 10)}`;
  let tab: Tab = "presets";
  let confirming: string | null = null;
  let confirmTimer = 0;
  let statusTimer = 0;
  /** The preset slot the select stands on; it follows the list unless the listener moved it. */
  let picked: number | null = null;
  /** The same for messages. */
  let pickedMessage: number | null = null;

  // Presets.
  const slot = el("select", {
    className: "input input--compact geiss-presets__slot",
    attrs: { "aria-label": t("Miejsce na preset") }
  }) as HTMLSelectElement;
  const save = el("button", { className: "button button--primary geiss-presets__save", attrs: { type: "button" } });
  const list = el("ul", { className: "geiss-presets__list", attrs: { "aria-label": t("Zapisane presety") } });
  const empty = el("p", { className: "geiss-presets__empty", text: t("Nic tu jeszcze nie ma: zapisz mapę, która jest na ekranie.") });
  const presetsPane = el("div", { className: "geiss-presets__pane", attrs: { id: `${id}-presets`, role: "tabpanel", "aria-labelledby": `${id}-tab-presets` } },
    el("div", { className: "geiss-presets__save-row" }, slot, save),
    list, empty);

  // Messages.
  const messageSlot = el("select", {
    className: "input input--compact geiss-presets__slot geiss-messages__slot",
    attrs: { "aria-label": t("Miejsce na napis") }
  }) as HTMLSelectElement;
  const messageInput = el("input", {
    className: "input input--compact geiss-messages__text",
    attrs: { type: "text", maxlength: MESSAGE_LENGTH + 2, placeholder: t("Treść napisu"), "aria-label": t("Treść napisu"), autocomplete: "off", spellcheck: "false" }
  }) as HTMLInputElement;
  const messageSave = el("button", { className: "button button--primary geiss-presets__save geiss-messages__save", attrs: { type: "submit" } });
  const messageList = el("ul", { className: "geiss-presets__list geiss-messages__list", attrs: { "aria-label": t("Zapisane napisy") } });
  const messageEmpty = el("p", { className: "geiss-presets__empty", text: t("Nie ma jeszcze napisów: wpisz tekst i zapisz go w wolnym miejscu.") });
  const messageForm = el("form", { className: "geiss-messages__form" },
    el("div", { className: "geiss-presets__save-row" }, messageSlot),
    el("div", { className: "geiss-presets__save-row" }, messageInput, messageSave));
  const messagesPane = el("div", { className: "geiss-presets__pane", attrs: { id: `${id}-messages`, role: "tabpanel", "aria-labelledby": `${id}-tab-messages`, hidden: true } },
    el("p", { className: "geiss-presets__hint", text: t("Napis pokazuje się jak tytuł utworu i po chwili wtapia w obraz (m## w oryginale).") }),
    messageForm, messageList, messageEmpty);

  // The tabs.
  const tabButton = (name: Tab, label: string): HTMLButtonElement => {
    const button = el("button", {
      className: "geiss-presets__tab",
      text: label,
      attrs: { type: "button", role: "tab", id: `${id}-tab-${name}`, "aria-controls": `${id}-${name}` }
    }) as HTMLButtonElement;
    button.addEventListener("click", () => {
      tab = name;
      confirming = null;
      refresh();
    });
    return button;
  };
  const presetsTab = tabButton("presets", t("Presety"));
  const messagesTab = tabButton("messages", t("Własne napisy"));
  const tabs = el("div", { className: "geiss-presets__tabs", attrs: { role: "tablist", "aria-label": "GEISS.INI" } }, presetsTab, messagesTab);
  const head = el("div", { className: "geiss-presets__head" }, tabs, el("span", { className: "geiss-presets__file", text: "GEISS.INI", attrs: { "aria-hidden": "true" } }));
  // Arrow keys move between the two tabs, as a tab list does.
  tabs.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    tab = tab === "presets" ? "messages" : "presets";
    refresh();
    (tab === "presets" ? presetsTab : messagesTab).focus();
  });

  // The option.
  const sync = el("input", { className: "geiss-presets__check", attrs: { type: "checkbox" } }) as HTMLInputElement;
  const option = el("label", { className: "geiss-presets__option" },
    sync,
    el("span", {},
      el("span", { className: "geiss-presets__option-name", text: t("Kolory fal według muzyki") }),
      el("span", { className: "geiss-presets__option-hint", text: t("Opcja Geissa, domyślnie wyłączona. Działa w kolorze 16- i 32-bitowym.") })));

  const status = el("p", { className: "geiss-presets__status", attrs: { role: "status", "aria-live": "polite" } });
  const card = el("div", { className: "geiss-presets__card", attrs: { id, hidden: true } },
    head, presetsPane, messagesPane, option, status);
  const toggle = el("button", {
    className: "geiss-presets__toggle",
    attrs: { type: "button", "aria-expanded": "false", "aria-controls": id, title: t("Presety, napisy i opcje Geissa (]##, [## i m## w oryginale)") }
  }, icon("settings"), el("span", { text: t("Presety i napisy") }));
  const element = el("div", { className: "visualizer-panel__overlay geiss-presets" }, card, toggle);

  const say = (text: string): void => {
    status.textContent = text;
    window.clearTimeout(statusTimer);
    statusTimer = window.setTimeout(() => {
      status.textContent = "";
    }, CONFIRM_MS);
  };

  /** A delete button that asks once more before it calls `remove`. */
  const removeButton = (key: string, labels: { ask: string; plain: string }, remove: () => void): HTMLButtonElement => {
    const asking = confirming === key;
    const button = el("button", {
      className: `button button--quiet geiss-presets__remove${asking ? " is-confirming" : ""}`,
      attrs: { type: "button", "aria-label": asking ? labels.ask : labels.plain, title: asking ? t("Kliknij jeszcze raz, żeby usunąć") : t("Usuń") }
    }, asking ? el("span", { text: t("Usunąć?") }) : icon("trash")) as HTMLButtonElement;
    button.addEventListener("click", () => {
      window.clearTimeout(confirmTimer);
      if (confirming !== key) {
        confirming = key;
        confirmTimer = window.setTimeout(() => {
          confirming = null;
          refresh();
        }, CONFIRM_MS);
        refresh();
        return;
      }
      confirming = null;
      remove();
    });
    return button;
  };

  const slotOptions = (count: number, label: (number: number) => string): HTMLOptionElement[] => {
    const options: HTMLOptionElement[] = [];
    for (let number = 0; number < count; number += 1) options.push(el("option", { text: label(number), attrs: { value: String(number) } }) as HTMLOptionElement);
    // 01 first, as the keys would be typed; 00 at the end.
    options.push(options.shift()!);
    return options;
  };

  const refreshPresets = (): void => {
    const presets = host.presets();
    const target = picked !== null && picked < PRESET_SLOTS ? picked : freeSlot(presets) ?? host.shown() ?? 1;
    slot.replaceChildren(...slotOptions(PRESET_SLOTS, (number) => {
      const preset = presets.get(number);
      return preset ? t("{slot}: {map} (nadpisz)", { slot: slotName(number), map: host.mapName(preset) }) : t("{slot}: wolne", { slot: slotName(number) });
    }));
    slot.value = String(target);
    save.textContent = presets.has(target) ? t("Nadpisz") : t("Zapisz");

    const shown = host.shown();
    list.replaceChildren(...[...presets].map(([number, preset]) => {
      const name = slotName(number);
      const load = el("button", {
        className: "button button--secondary geiss-presets__load",
        text: shown === number ? t("Na ekranie") : t("Wczytaj"),
        attrs: { type: "button", "aria-label": t("Wczytaj preset {slot}", { slot: name }), disabled: shown === number }
      });
      load.addEventListener("click", () => host.load(number));
      const remove = removeButton(`preset-${number}`, { ask: t("Na pewno usunąć preset {slot}?", { slot: name }), plain: t("Usuń preset {slot}", { slot: name }) }, () => {
        host.remove(number);
        say(t("Usunięto preset {slot}.", { slot: name }));
      });
      return el("li", { className: `geiss-presets__item${shown === number ? " is-shown" : ""}` },
        el("span", { className: "geiss-presets__number", text: name }),
        el("span", { className: "geiss-presets__name", text: host.mapName(preset) }),
        load, remove);
    }));
    empty.hidden = presets.size > 0;
  };

  const refreshMessages = (): void => {
    const messages = host.messages();
    const target = pickedMessage !== null && pickedMessage < MESSAGE_SLOTS ? pickedMessage : freeSlot(messages) ?? 1;
    messageSlot.replaceChildren(...slotOptions(MESSAGE_SLOTS, (number) => {
      const value = messages.get(number);
      return value !== undefined ? t("{slot}: {text} (nadpisz)", { slot: slotName(number), text: messageText(value) }) : t("{slot}: wolne", { slot: slotName(number) });
    }));
    messageSlot.value = String(target);
    messageSave.textContent = messages.has(target) ? t("Nadpisz") : t("Zapisz");

    messageList.replaceChildren(...[...messages].map(([number, value]) => {
      const name = slotName(number);
      const text = messageText(value);
      const show = el("button", {
        className: "button button--secondary geiss-presets__load geiss-messages__show",
        text: t("Pokaż"),
        attrs: { type: "button", "aria-label": t("Pokaż napis {slot}", { slot: name }) }
      });
      show.addEventListener("click", () => {
        host.showMessage(number);
        say(t("Napis {slot} na ekranie.", { slot: name }));
      });
      const edit = el("button", {
        className: "button button--quiet geiss-presets__remove geiss-messages__edit",
        attrs: { type: "button", "aria-label": t("Zmień napis {slot}", { slot: name }), title: t("Zmień") }
      }, icon("edit"));
      edit.addEventListener("click", () => {
        pickedMessage = number;
        messageInput.value = value;
        refresh();
        messageInput.focus();
      });
      const remove = removeButton(`message-${number}`, { ask: t("Na pewno usunąć napis {slot}?", { slot: name }), plain: t("Usuń napis {slot}", { slot: name }) }, () => {
        host.removeMessage(number);
        say(t("Usunięto napis {slot}.", { slot: name }));
      });
      return el("li", { className: "geiss-presets__item geiss-messages__item" },
        el("span", { className: "geiss-presets__number", text: name }),
        el("span", { className: "geiss-presets__name", text, attrs: { title: text } }),
        show, edit, remove);
    }));
    messageEmpty.hidden = messages.size > 0;
  };

  const refresh = (): void => {
    const onPresets = tab === "presets";
    presetsTab.setAttribute("aria-selected", String(onPresets));
    messagesTab.setAttribute("aria-selected", String(!onPresets));
    presetsTab.tabIndex = onPresets ? 0 : -1;
    messagesTab.tabIndex = onPresets ? -1 : 0;
    presetsPane.hidden = !onPresets;
    messagesPane.hidden = onPresets;
    sync.checked = host.syncColour();
    refreshPresets();
    refreshMessages();
  };

  slot.addEventListener("change", () => {
    picked = Number(slot.value);
    save.textContent = host.presets().has(picked) ? t("Nadpisz") : t("Zapisz");
  });
  save.addEventListener("click", () => {
    const number = Number(slot.value);
    if (!host.save(number)) {
      say(t("Nie udało się zapisać presetu."));
      return;
    }
    picked = null;
    refresh();
    say(t("Zapisano w {slot}.", { slot: slotName(number) }));
  });
  messageSlot.addEventListener("change", () => {
    pickedMessage = Number(messageSlot.value);
    messageSave.textContent = host.messages().has(pickedMessage) ? t("Nadpisz") : t("Zapisz");
  });
  messageForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const number = Number(messageSlot.value);
    const value = messageInput.value;
    if (messageText(value) === "") {
      say(t("Wpisz treść napisu."));
      messageInput.focus();
      return;
    }
    if (!host.saveMessage(number, value)) {
      say(t("Nie udało się zapisać napisu."));
      return;
    }
    pickedMessage = null;
    messageInput.value = "";
    refresh();
    say(t("Zapisano napis w {slot}.", { slot: slotName(number) }));
  });
  sync.addEventListener("change", () => host.setSyncColour(sync.checked));
  toggle.addEventListener("click", () => {
    const open = card.hidden === true;
    card.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.classList.toggle("is-active", open);
    if (open) {
      picked = null;
      pickedMessage = null;
      refresh();
    }
  });
  refresh();
  return { element, refresh };
}
