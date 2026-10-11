/** Resolve a widget and its header within the owning grid. */
export function resolveWidgetGrabElements(
  target: EventTarget | null,
  container: HTMLElement,
): { card: HTMLElement; header: HTMLElement } | null {
  const element = target instanceof Element ? target : null;
  const card = element?.closest<HTMLElement>("[data-widget-id]");
  if (!card || !container.contains(card)) return null;

  const owner = card.closest<HTMLElement>(".reorderable-widget-grid");
  if (owner && owner !== container) return null;

  const header = [...card.querySelectorAll<HTMLElement>(".widget-header")]
    .find((candidate) => candidate.closest("[data-widget-id]") === card);
  if (!header) return null;

  return { card, header };
}

/** Resolve a pointer press that belongs to the draggable top area of a widget. */
export function resolveWidgetGrabRegion(
  target: EventTarget | null,
  clientX: number,
  clientY: number,
  container: HTMLElement,
): { card: HTMLElement; header: HTMLElement } | null {
  const region = resolveWidgetGrabElements(target, container);
  if (!region) return null;
  const { card, header } = region;
  const element = target instanceof Element ? target : null;

  // Header descendants remain eligible; geometry extends the grab area into
  // the card's top padding.
  if (header === element || header.contains(element)) return { card, header };

  const cardRect = card.getBoundingClientRect();
  const headerRect = header.getBoundingClientRect();
  if (clientX < cardRect.left || clientX > cardRect.right
    || clientY < cardRect.top || clientY > cardRect.bottom
    || clientY > headerRect.bottom) return null;

  return { card, header };
}
