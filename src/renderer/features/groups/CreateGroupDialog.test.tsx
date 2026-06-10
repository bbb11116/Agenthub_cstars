import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CreateGroupDialog } from "./CreateGroupDialog";

describe("CreateGroupDialog", () => {
  it("allows an empty Agent selection but disables submission until the group name is present", () => {
    const markup = renderToStaticMarkup(
      <CreateGroupDialog
        agents={[]}
        open
        onClose={() => undefined}
        onCreate={async () => undefined}
      />
    );

    expect(markup).toContain("创建群聊");
    expect(markup).toContain("群聊描述（可选）");
    expect(markup).toContain("暂未选择子 Agent，创建后也可以在群聊设置中添加。");
    expect(markup).toContain('<button disabled="" type="submit">创建群聊</button>');
  });
});
