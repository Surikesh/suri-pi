import { createPortal } from "react-dom";
import { modelKey } from "../../model-search.js";
import { useModelSearch, type ModelSearchProps } from "./use-model-search.js";

export function ModelSearchPicker({
  sessionId,
  display,
  selected,
  disabled,
  starting,
  models,
  cached,
  prefetchError,
  scope,
  openSignal,
  load,
  choose,
}: ModelSearchProps) {
  const {
    open,
    setQuery,
    setBrowse,
    query,
    phase,
    error,
    active,
    setActive,
    setWindowStart,
    menuPosition,
    trigger,
    input,
    menu,
    list,
    intent,
    options,
    duplicateNames,
    virtual,
    start,
    visible,
    rowEstimate,
    close,
    discover,
    show,
    selectModel,
  } = useModelSearch({
    selected,
    starting,
    models,
    cached,
    prefetchError,
    scope,
    openSignal,
    load,
    choose,
  });
  return (
    <div className="picker model-search-picker">
      <button
        ref={trigger}
        aria-label="Model"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
        onKeyDown={(event) => {
          if (
            open ||
            event.key !== "Tab" ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey
          )
            return;
          const composer = trigger.current?.closest(".composer");
          const adjacent = event.shiftKey
            ? composer?.querySelector<HTMLTextAreaElement>(
                'textarea[aria-label="Message Pi"]',
              )
            : composer?.querySelector<HTMLButtonElement>(
                'button[aria-label="Attach file"]:not(:disabled)',
              );
          if (adjacent) {
            event.preventDefault();
            adjacent.focus();
          }
        }}
      >
        {display}
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            className="picker-menu model-search-menu"
            style={{
              position: "fixed",
              left: menuPosition.left,
              right: "auto",
              bottom: menuPosition.bottom,
            }}
          >
            <input
              ref={input}
              type="search"
              role="combobox"
              aria-label="Search models"
              aria-controls={`model-options-${sessionId}`}
              aria-expanded="true"
              aria-autocomplete="list"
              aria-activedescendant={
                active >= start && active < start + visible.length
                  ? `model-option-${sessionId}-${active}`
                  : undefined
              }
              placeholder="Search models"
              value={query}
              onChange={(event) => {
                setBrowse(false);
                setQuery(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const next = Math.max(
                    0,
                    Math.min(
                      options.length - 1,
                      active + (event.key === "ArrowDown" ? 1 : -1),
                    ),
                  );
                  setActive(next);
                  if (
                    virtual &&
                    (next < start || next >= start + visible.length)
                  )
                    list.current?.scrollTo({
                      top: Math.max(0, next - 6) * rowEstimate,
                    });
                  requestAnimationFrame(() =>
                    document
                      .getElementById(`model-option-${sessionId}-${next}`)
                      ?.scrollIntoView({ block: "nearest" }),
                  );
                }
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  if (!starting && phase === "ready" && options[active])
                    void selectModel(options[active]);
                }
              }}
            />
            {!intent && (
              <button onClick={() => setBrowse(true)}>Show all models</button>
            )}
            {intent && phase === "loading" && (
              <p role="status">Loading models…</p>
            )}
            {phase === "selecting" && <p role="status">Setting model…</p>}
            {intent && phase === "error" && (
              <p role="alert">
                {error}{" "}
                <button onClick={() => void discover(true)}>
                  Retry discovery
                </button>
              </p>
            )}
            {intent && phase === "selection-error" && (
              <p role="alert">
                {error}{" "}
                <button onClick={() => void discover(true)}>
                  Reload models
                </button>
              </p>
            )}
            {intent && phase === "ready" && (
              <span className="model-status-sr" role="status">
                Models ready
              </span>
            )}
            {intent &&
              phase === "ready" &&
              selected &&
              !models.some((model) => modelKey(model) === selected) && (
                <p className="picker-empty">
                  Current model {selected} is unavailable in this catalog.
                </p>
              )}
            <div
              ref={list}
              id={`model-options-${sessionId}`}
              role="listbox"
              aria-label="Model"
              className="model-search-options"
              onScroll={(event) => {
                if (!virtual) return;
                const focused = document.activeElement;
                if (
                  focused?.getAttribute("role") === "option" &&
                  event.currentTarget.contains(focused)
                ) {
                  const bounds = focused.getBoundingClientRect();
                  const viewport = event.currentTarget.getBoundingClientRect();
                  if (
                    bounds.bottom > viewport.top &&
                    bounds.top < viewport.bottom
                  )
                    return;
                }
                const next = Math.max(
                  0,
                  Math.min(
                    options.length - 40,
                    Math.floor(event.currentTarget.scrollTop / rowEstimate) - 6,
                  ),
                );
                if (next !== start) {
                  setWindowStart(next);
                  setActive((current) =>
                    current < next || current >= next + 40 ? next : current,
                  );
                }
              }}
            >
              {intent && phase === "ready" && options.length === 0 && (
                <span className="picker-empty">
                  {models.length === 0
                    ? "No models available"
                    : scope?.length === 0 && !selected
                      ? "No models in scope"
                      : "No matching models"}
                </span>
              )}
              {virtual && (
                <div
                  aria-hidden="true"
                  style={{ height: start * rowEstimate }}
                />
              )}
              {intent &&
                phase === "ready" &&
                visible.map((model, index) => {
                  const name = model.name || model.id;
                  const duplicate =
                    (duplicateNames.get(`${model.provider}\0${name}`) ?? 0) > 1;
                  const label = `${model.provider} · ${name}${duplicate && name !== model.id ? ` (${model.id})` : ""}`;
                  const optionIndex = start + index;
                  return (
                    <button
                      id={`model-option-${sessionId}-${optionIndex}`}
                      type="button"
                      role="option"
                      aria-label={
                        name === model.id || duplicate
                          ? label
                          : `${label} (${model.id})`
                      }
                      aria-selected={optionIndex === active}
                      disabled={starting}
                      key={modelKey(model)}
                      onMouseEnter={() => setActive(optionIndex)}
                      onClick={() => void selectModel(model)}
                    >
                      <span className="model-search-label">{label}</span>
                    </button>
                  );
                })}
              {virtual && (
                <div
                  aria-hidden="true"
                  style={{
                    height:
                      (options.length - start - visible.length) * rowEstimate,
                  }}
                />
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
