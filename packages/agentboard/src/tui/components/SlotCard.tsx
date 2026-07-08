import { Show } from "solid-js";
import type { Accessor } from "solid-js";
import type { SlotInfo, Theme } from "../../runtime/index";
import { truncate } from "../../runtime/index";
import { DIM } from "../constants";
import { DiffStats } from "./DiffStats";
import { familyColor } from "./family-color";

export interface SlotCardProps {
  slot: SlotInfo;
  isFocused: boolean;
  theme: Accessor<Theme>;
  onSelect: () => void;
}

export function SlotCard(props: SlotCardProps) {
  const P = () => props.theme().palette;

  const familyHue = () => familyColor(props.slot.name, P());
  const nameColor = () => (props.isFocused ? P().text : familyHue());

  const truncName = () => truncate(props.slot.name, 18);
  const truncBranch = () => (props.slot.branch ? truncate(props.slot.branch, 45) : "");

  const hasDiff = () => {
    const { linesAdded, linesRemoved, commitsDelta, filesChanged } = props.slot;
    return !!(linesAdded || linesRemoved || commitsDelta || filesChanged);
  };

  const bgColor = () => (props.isFocused ? P().surface0 : "transparent");

  return (
    <box flexDirection="column" flexShrink={0}>
      <box
        flexDirection="row"
        backgroundColor={bgColor()}
        onMouseDown={props.onSelect}
        paddingLeft={1}
      >
        <text style={{ fg: props.isFocused ? P().lavender : "transparent" }}>
          {props.isFocused ? "▌" : " "}
        </text>

        <box flexDirection="column" flexGrow={1} paddingRight={1}>
          <box flexDirection="row" height={1}>
            <text truncate flexGrow={1}>
              <span style={{ fg: nameColor(), attributes: props.isFocused ? undefined : DIM }}>
                {truncName()}
              </span>
            </text>
            <Show when={hasDiff()}>
              <box flexShrink={0} paddingLeft={1}>
                <DiffStats session={props.slot} palette={() => P()} />
              </box>
            </Show>
          </box>

          <box flexDirection="row" height={1}>
            <Show when={props.slot.branch}>
              <text truncate flexShrink={1} flexGrow={1}>
                <span style={{ fg: props.isFocused ? P().pink : P().overlay0 }}>
                  {truncBranch()}
                </span>
              </text>
            </Show>
            <text flexShrink={0}>
              <span style={{ fg: P().overlay0, attributes: DIM }}>not started</span>
            </text>
          </box>

          <Show when={props.isFocused}>
            <text>
              <span style={{ fg: P().overlay1 }}>enter</span>
              <span style={{ fg: P().overlay0 }}> start claude · </span>
              <span style={{ fg: P().overlay1 }}>s</span>
              <span style={{ fg: P().overlay0 }}> shell</span>
            </text>
          </Show>
        </box>
      </box>
    </box>
  );
}
