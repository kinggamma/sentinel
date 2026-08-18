/**
 * Building blocks for screens.
 *
 * Everything here creates elements rather than parsing HTML strings: report
 * notes, error messages and stack frames are all attacker-influenced text,
 * and textContent can't be talked into becoming markup. It also means a
 * screen's structure is readable in one place rather than split between a
 * template and the code that fills it.
 */

export const el = (id) => document.getElementById(id);

/**
 * @param {string} tag
 * @param {object} [options] - className, text, attrs, style, on (events), and
 *   children, which accepts nodes, strings, or nulls to skip.
 */
export function h(tag, options = {}, ...children) {
  const node = document.createElement(tag);
  const { className, text, attrs, style, on, ...rest } = options;

  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value !== null && value !== undefined && value !== false) {
      node.setAttribute(key, value === true ? "" : String(value));
    }
  }
  for (const [key, value] of Object.entries(style || {})) {
    node.style.setProperty(key, value);
  }
  for (const [event, handler] of Object.entries(on || {})) {
    node.addEventListener(event, handler);
  }
  // Anything left is a direct property, for the cases attributes can't do:
  // checked, disabled, value, htmlFor.
  Object.assign(node, rest);

  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Replace an element's contents in one go, without innerHTML. */
export function fill(node, ...children) {
  node.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined));
  return node;
}

export function emptyState(message) {
  return h("p", { className: "empty", text: message });
}

export function card(...children) {
  return h("section", { className: "card" }, children);
}

export function tag(text, { kind = "", hue = null } = {}) {
  const node = h("span", { className: `tag ${kind}`.trim(), text });
  if (hue !== null) node.style.setProperty("--project-hue", String(hue));
  return node;
}

/** A definition list. Pairs whose value is empty are dropped, not blanked. */
export function kv(pairs) {
  const list = h("dl", { className: "kv" });
  for (const [key, value] of pairs) {
    if (value === null || value === undefined || value === "") continue;
    list.append(
      h("dt", { text: key }),
      value instanceof Node ? h("dd", {}, value) : h("dd", { text: value })
    );
  }
  return list;
}

/**
 * @param {string[]} columns
 * @param {Array<{cells: Array, className?: string, dataset?: object}>} rows
 */
export function table(columns, rows, { className = "" } = {}) {
  const head = h(
    "tr",
    {},
    columns.map((column) =>
      typeof column === "string" ? h("th", { text: column }) : h("th", { className: column.className, text: column.label })
    )
  );

  const body = h("tbody", {});
  for (const row of rows) {
    const tr = h("tr", { className: row.className || "" });
    Object.assign(tr.dataset, row.dataset || {});
    tr.append(...row.cells.map((cell) => (cell instanceof Node ? h("td", {}, cell) : h("td", { text: cell ?? "" }))));
    body.append(tr);
  }

  return h("table", { className: `data-table ${className}`.trim() }, h("thead", {}, head), body);
}

export function field({ label, id, type = "text", value = "", placeholder = "", ...rest }) {
  const input = h("input", { id, type, value, attrs: { placeholder }, ...rest });
  return {
    input,
    node: h("label", { className: "field" }, h("span", { className: "field-label", text: label }), input),
  };
}

/**
 * A dialog. Closing on the backdrop and on Escape used to be written out
 * separately for each of the three overlays that existed.
 */
export function modal({ title, body, actions = [], onClose } = {}) {
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
    onClose?.();
  };
  const onKey = (event) => {
    if (event.key === "Escape") close();
  };

  const panel = h(
    "section",
    { className: "modal-card" },
    title ? h("h2", { text: title }) : null,
    body,
    actions.length ? h("div", { className: "modal-actions" }, actions) : null
  );

  const overlay = h(
    "div",
    { className: "modal", on: { click: (event) => event.target === overlay && close() } },
    panel
  );

  document.body.append(overlay);
  document.addEventListener("keydown", onKey);
  return { close, panel };
}

/**
 * "Are you sure?", for the things that cannot be taken back.
 *
 * Removing somebody from an organisation, deleting a team, revoking a key:
 * each was one click, next to ordinary buttons, with no step between
 * deciding and having done it. None of them undo — a revoked key cannot be
 * un-revoked, and a deleted team takes everyone's route to its projects with
 * it — so each is worth one deliberate second.
 *
 * The message says what will happen rather than asking whether the person is
 * sure, because "are you sure?" is answerable without reading and "this
 * stops every app reporting" is not.
 *
 * @param {object} options
 * @param {string} options.title - what is about to happen.
 * @param {string} options.detail - what it means, in a sentence.
 * @param {string} [options.confirm] - the label on the button that does it.
 * @returns {Promise<boolean>} whether to go ahead.
 */
export function confirmAction({ title, detail, confirm = "Yes, do it" } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const answer = (value) => {
      if (answered) return;
      answered = true;
      resolve(value);
      dialog.close();
    };

    const go = h("button", {
      type: "button",
      className: "danger",
      text: confirm,
      on: { click: () => answer(true) },
    });

    const dialog = modal({
      title,
      body: h("p", { className: "muted", text: detail }),
      actions: [
        h("button", { type: "button", className: "ghost", text: "Cancel", on: { click: () => answer(false) } }),
        go,
      ],
      // Escape and clicking away are answers too, and the answer is no.
      onClose: () => answer(false),
    });

    go.focus();
  });
}
