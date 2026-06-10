import { useEffect, useState, type FormEvent } from "react";
import type { AgentSkillCategory } from "../../../shared/types";
import { SkillMultiSelect } from "./SkillMultiSelect";

export type CreateSubAgentForm = {
  provider: "builtin_openai" | "codex_local" | "claude_code" | "opencode";
  name: string;
  description: string;
  skillIds: string[];
};

type AddSubAgentDialogProps = {
  open: boolean;
  onClose: () => void;
  onCreate: (form: CreateSubAgentForm) => Promise<void>;
};

const PROVIDER_OPTIONS: Array<{
  value: CreateSubAgentForm["provider"];
  label: string;
}> = [
  { value: "builtin_openai", label: "AgentHub 内置" },
  { value: "codex_local", label: "本地 Codex" },
  { value: "claude_code", label: "Claude Code" },
  { value: "opencode", label: "OpenCode" }
];

const EMPTY_FORM: CreateSubAgentForm = {
  provider: "builtin_openai",
  name: "",
  description: "",
  skillIds: []
};

function getApi() {
  if (!window.agenthub) {
    throw new Error("AgentHub API 不可用。");
  }
  return window.agenthub;
}

export function AddSubAgentDialog({
  open,
  onClose,
  onCreate
}: AddSubAgentDialogProps) {
  const [form, setForm] = useState<CreateSubAgentForm>(EMPTY_FORM);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skillCatalog, setSkillCatalog] = useState<AgentSkillCategory[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    setForm(EMPTY_FORM);
    setError(null);
    setIsCreating(false);
    setSkillsError(null);
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;
    setSkillsLoading(true);
    getApi()
      .skill.listCatalog()
      .then((catalog) => {
        if (!cancelled) {
          setSkillCatalog(catalog);
          setSkillsLoading(false);
        }
      })
      .catch((loadError) => {
        if (!cancelled) {
          setSkillsError(loadError instanceof Error ? loadError.message : "加载技能失败。");
          setSkillsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape" && !isCreating) {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isCreating, onClose, open]);

  if (!open) {
    return null;
  }

  const normalizedName = form.name.trim();
  const normalizedDescription = form.description.trim();
  const canCreate =
    normalizedName.length > 0 &&
    form.provider.length > 0 &&
    !isCreating;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    if (!canCreate) {
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      await onCreate({
        provider: form.provider,
        name: normalizedName,
        description: normalizedDescription,
        skillIds: form.skillIds
      });
      onClose();
    } catch (creationError) {
      setError(
        creationError instanceof Error
          ? creationError.message
          : "创建子 Agent 失败。"
      );
      setIsCreating(false);
    }
  }

  return (
    <div
      className="add-sub-agent-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isCreating) {
          onClose();
        }
      }}
    >
      <section
        aria-labelledby="add-sub-agent-title"
        aria-modal="true"
        className="add-sub-agent-dialog"
        role="dialog"
      >
        <header className="add-sub-agent-dialog-header">
          <div>
            <span className="eyebrow">工作区 Agent</span>
            <h2 id="add-sub-agent-title">添加子 Agent</h2>
          </div>
          <button
            aria-label="关闭添加子 Agent 对话框"
            disabled={isCreating}
            onClick={onClose}
            type="button"
          >
            x
          </button>
        </header>

        <form className="add-sub-agent-form" onSubmit={(event) => void handleSubmit(event)}>
          <label>
            <span>模型来源</span>
            <select
              disabled={isCreating}
              value={form.provider}
              onChange={(event) =>
                setForm({
                  ...form,
                  provider: event.target.value as CreateSubAgentForm["provider"]
                })
              }
            >
              {PROVIDER_OPTIONS.map((provider) => (
                <option key={provider.value} value={provider.value}>
                  {provider.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>Agent 名称</span>
            <input
              autoFocus
              disabled={isCreating}
              placeholder="前端 Agent"
              type="text"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </label>

          <label>
            <span>Agent 描述（可选）</span>
            <textarea
              disabled={isCreating}
              placeholder="负责 React UI 实现，并提出有针对性的 diff。"
              rows={4}
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
            />
          </label>

          <SkillMultiSelect
            catalog={skillCatalog}
            disabled={isCreating}
            error={skillsError}
            loading={skillsLoading}
            selectedSkillIds={form.skillIds}
            onChange={(skillIds) => setForm({ ...form, skillIds })}
          />

          {error ? (
            <p className="add-sub-agent-form-error" role="alert">
              {error}
            </p>
          ) : null}

          <div className="add-sub-agent-dialog-actions">
            <button disabled={isCreating} onClick={onClose} type="button">
              取消
            </button>
            <button disabled={!canCreate} type="submit">
              {isCreating ? "创建中..." : "创建子 Agent"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
