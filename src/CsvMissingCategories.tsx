import { translateText as uiText } from "./i18n";
import { ColorPicker, EmojiField } from "./Appearance";
import type { Category } from "./domain";

export function CsvMissingCategories({
  missingCategories,
  busy,
  reading,
  manualCategories,
  creating,
  onToggleManual,
  onSetCreating,
  onCreateAll,
  onCreateOne,
}: {
  missingCategories: string[];
  busy: boolean;
  reading: boolean;
  manualCategories: boolean;
  creating: string | null;
  onToggleManual: () => void;
  onSetCreating: (name: string | null) => void;
  onCreateAll: () => void;
  onCreateOne: (value: Omit<Category, "id">) => Promise<void>;
}) {
  if (!missingCategories.length) return null;
  return (
    <section className="missing-categories">
      <h3>{uiText("Missing categories")}</h3>
      <p className="muted">
        {missingCategories.length} {uiText("missing categories. Create them all with random colors and blank descriptions and emojis, or configure each one yourself.")} </p>
      <div className="csv-category-actions">
        <button
          className="primary"
          disabled={busy || reading}
          onClick={onCreateAll}
        > {uiText("Create all missing categories")} </button>
        <button
          className="secondary"
          disabled={busy || reading}
          aria-expanded={manualCategories}
          onClick={onToggleManual}
        >
          {manualCategories
            ? uiText("Hide individual configuration")
            : uiText("Configure individually")}
        </button>
      </div>
      {manualCategories &&
        missingCategories.map((name) => (
          <div key={name}>
            <button
              className="secondary"
              disabled={busy || reading}
              onClick={() => onSetCreating(name)}
            > {uiText("Create")} {name}
            </button>
            {creating === name && (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  await onCreateOne({
                    name,
                    description: String(f.get("description") ?? ""),
                    color: String(f.get("color")),
                    emoji: String(f.get("emoji") ?? ""),
                  });
                }}
              >
                <fieldset disabled={busy}>
                  <p>{name}</p>
                  {name.length > 80 && (
                    <p role="alert"> {uiText("Correct this category name in the CSV: maximum 80 characters.")} </p>
                  )}
                  <label> {uiText("Description (optional)")} <input name="description" maxLength={500} />
                  </label>
                  <EmojiField />
                  <ColorPicker />
                  <button className="primary" disabled={name.length > 80}> {uiText("Confirm creation")} </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => onSetCreating(null)}
                  > {uiText("Cancel")} </button>
                </fieldset>
              </form>
            )}
          </div>
        ))}
    </section>
  );
}
