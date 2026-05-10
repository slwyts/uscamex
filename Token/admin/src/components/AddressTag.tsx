import { Tag, Tooltip, App } from "antd";
import { CopyOutlined } from "@ant-design/icons";
import { shortAddress } from "../utils/address";

interface Props {
  value: string | null | undefined;
  full?: boolean;
  copyable?: boolean;
  color?: string;
}

export default function AddressTag({ value, full = false, copyable = true, color }: Props) {
  const { message } = App.useApp();
  if (!value) return <span style={{ color: "rgba(255,255,255,0.4)" }}>-</span>;
  const text = full ? value : shortAddress(value);
  return (
    <Tooltip title={value} mouseEnterDelay={0.4}>
      <span className="address-mono">
        {color ? <Tag color={color} className="tag-mini">{text}</Tag> : text}
        {copyable && (
          <CopyOutlined
            className="copy-btn"
            onClick={async () => {
              await navigator.clipboard.writeText(value);
              message.success("已复制");
            }}
          />
        )}
      </span>
    </Tooltip>
  );
}
