import { Show } from "solid-js";
import type { Accessor } from "solid-js";
import type { SessionData, Theme } from "../../runtime/index";

export interface DiffStatsProps {
  session: Pick<SessionData, "filesChanged" | "linesAdded" | "linesRemoved" | "commitsDelta">;
  palette: Accessor<Theme["palette"]>;
}

export function DiffStats(props: DiffStatsProps) {
  const P = () => props.palette();
  const s = () => props.session;

  return (
    <text flexShrink={0}>
      <Show when={s().filesChanged}>
        <span style={{ fg: P().overlay0 }}>{s().filesChanged}f </span>
      </Show>
      <Show when={s().linesAdded}>
        <span style={{ fg: P().green }}>+{s().linesAdded} </span>
      </Show>
      <Show when={s().linesRemoved}>
        <span style={{ fg: P().red }}>-{s().linesRemoved} </span>
      </Show>
      <Show when={s().commitsDelta > 0}>
        <span style={{ fg: P().sky }}>{s().commitsDelta}↑</span>
      </Show>
      <Show when={s().commitsDelta < 0}>
        <span style={{ fg: P().peach }}>{Math.abs(s().commitsDelta)}↓</span>
      </Show>
    </text>
  );
}
