import { useId, useState, type KeyboardEvent, type ReactNode } from "react";

/** A touch screen: its keyboard has no Shift for a new line. */
const coarsePointer = () => typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;

export interface EnterToSend {
  /** Spread onto the message's textarea: its key handling and, while the hint shows, its description. */
  inputProps: { onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void; "aria-describedby": string | undefined };
  /** The hint to place next to the send button, or nothing. */
  hint: ReactNode;
}

/**
 * Enter sends a message and Shift+Enter is a new line; Ctrl+Enter (Cmd+Enter) sends too. Phone
 * keyboards have no Shift, so on touch screens (`(pointer: coarse)`) Enter stays a new line, the
 * button sends and no hint shows. The Enter that ends an input method's composition never sends.
 * `send` gets the key event and applies the same rules as the form's button; the hint shows while `active`.
 */
export function useEnterToSend(send: (event: KeyboardEvent<HTMLTextAreaElement>) => void, active: boolean): EnterToSend {
  const hintId = useId();
  const [touch] = useState(coarsePointer);
  const hinted = active && !touch;

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (!event.ctrlKey && !event.metaKey && touch) return;
    event.preventDefault();
    send(event);
  };

  return {
    inputProps: { onKeyDown, "aria-describedby": hinted ? hintId : undefined },
    hint: hinted ? (
      <span id={hintId} className="muted chat-hint">
        Enter to send · Shift+Enter for a new line
      </span>
    ) : null,
  };
}
