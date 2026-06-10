import { useEffect, useMemo, useState } from "react";
import type { AgentSkillCategory, AgentSkillSummary } from "../../../shared/types";
import { AppIcon, type AppIconName } from "../../components/ui/AppIcon";
import { useWorkspaceStore } from "../../state/workspaceStore";

type SkillLoadState =
  | { status: "loading"; message: string }
  | { status: "ready"; message: string }
  | { status: "error"; message: string };

type PendingSkillAction = {
  skillId: string;
  type: "add" | "remove";
};

const ALL_CATEGORIES = "__all__";

const categoryIconMap: Record<string, AppIconName> = {
  "计算机与数学职业": "runtime",
  "商业与金融运营类职业": "artifacts",
  "艺术、设计、娱乐、体育与媒体类职业": "sparkle",
  "办公室与行政支持类职业": "files",
  "教育与图书馆类职业": "preview",
  "生命、物理与社会科学类职业": "git",
  "法律类职业": "diff",
  "管理类职业": "users"
};

function getApi() {
  if (!window.agenthub) {
    throw new Error("AgentHub API is unavailable.");
  }
  return window.agenthub;
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function matchesSearch(skill: AgentSkillSummary, query: string): boolean {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) {
    return true;
  }

  return normalizeText(`${skill.name} ${skill.description} ${skill.category}`).includes(
    normalizedQuery
  );
}

function getAllSkills(catalog: AgentSkillCategory[]): AgentSkillSummary[] {
  return catalog.flatMap((category) => category.skills);
}

function formatTotal(total: number): string {
  return `${total} 个技能点`;
}

export function SkillLibraryView(): JSX.Element {
  const { activeAgent, activeWorkspace, loadHubCollections, loadWorkspaceTree } =
    useWorkspaceStore();
  const [catalog, setCatalog] = useState<AgentSkillCategory[]>([]);
  const [loadState, setLoadState] = useState<SkillLoadState>({
    status: "loading",
    message: "Loading skills"
  });
  const [selectedCategory, setSelectedCategory] = useState(ALL_CATEGORIES);
  const [query, setQuery] = useState("");
  const [pendingSkillAction, setPendingSkillAction] = useState<PendingSkillAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadState({ status: "loading", message: "Loading skills" });

    let api: Window["agenthub"];
    try {
      api = getApi();
    } catch (error) {
      if (!cancelled) {
        setLoadState({
          status: "error",
          message: error instanceof Error ? error.message : "Failed to load skills."
        });
      }
      return () => {
        cancelled = true;
      };
    }

    api.skill
      .listCatalog()
      .then((nextCatalog) => {
        if (!cancelled) {
          setCatalog(nextCatalog);
          setLoadState({ status: "ready", message: "Skills loaded" });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLoadState({
            status: "error",
            message: error instanceof Error ? error.message : "Failed to load skills."
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const allSkills = useMemo(() => getAllSkills(catalog), [catalog]);
  const activeCategory = catalog.find((category) => category.name === selectedCategory) ?? null;
  const visibleSkills = useMemo(() => {
    const source = activeCategory ? activeCategory.skills : allSkills;
    return source.filter((skill) => matchesSearch(skill, query));
  }, [activeCategory, allSkills, query]);
  const totalSkills = allSkills.length;
  const activeAgentSkillIds = useMemo(
    () => new Set(activeAgent?.skillIds ?? []),
    [activeAgent?.skillIds]
  );
  const currentCatalogSkillIds = useMemo(
    () => new Set(allSkills.map((skill) => skill.id)),
    [allSkills]
  );

  async function handleToggleSkill(skill: AgentSkillSummary): Promise<void> {
    if (!activeAgent || pendingSkillAction) {
      return;
    }

    const targetAgent = activeAgent;
    const workspaceId = activeWorkspace?.id;
    const isRemoving = activeAgentSkillIds.has(skill.id);
    const existingSkillIds = (targetAgent.skillIds ?? []).filter((skillId) =>
      currentCatalogSkillIds.has(skillId)
    );
    const nextSkillIds = isRemoving
      ? existingSkillIds.filter((skillId) => skillId !== skill.id)
      : Array.from(new Set([...existingSkillIds, skill.id]));

    setPendingSkillAction({ skillId: skill.id, type: isRemoving ? "remove" : "add" });
    setActionError(null);
    try {
      const updatedAgent = await getApi().agent.updateProfile({
        agentId: targetAgent.id,
        skillIds: nextSkillIds
      });
      if (!updatedAgent) {
        throw new Error("Agent not found.");
      }
      await Promise.all([
        loadHubCollections(),
        workspaceId ? loadWorkspaceTree(workspaceId) : Promise.resolve()
      ]);
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : isRemoving ? "取消添加失败。" : "添加技能点失败。"
      );
    } finally {
      setPendingSkillAction((currentAction) =>
        currentAction?.skillId === skill.id ? null : currentAction
      );
    }
  }

  return (
    <section className="skill-library-view" aria-label="技能点">
      <aside className="skill-library-categories" aria-label="技能分类">
        <button
          className={selectedCategory === ALL_CATEGORIES ? "active" : ""}
          type="button"
          onClick={() => setSelectedCategory(ALL_CATEGORIES)}
        >
          <span className="skill-library-category-icon">
            <AppIcon name="sparkle" />
          </span>
          <span>
            <strong>全部技能</strong>
            <small>{formatTotal(totalSkills)}</small>
          </span>
          <em>{totalSkills}</em>
        </button>
        {catalog.map((category) => (
          <button
            className={selectedCategory === category.name ? "active" : ""}
            key={category.name}
            type="button"
            onClick={() => setSelectedCategory(category.name)}
          >
            <span className="skill-library-category-icon">
              <AppIcon name={categoryIconMap[category.name] ?? "sparkle"} />
            </span>
            <span>
              <strong>{category.name}</strong>
              <small>{formatTotal(category.skills.length)}</small>
            </span>
            <em>{category.skills.length}</em>
          </button>
        ))}
      </aside>

      <div className="skill-library-main">
        <section
          className={
            activeAgent
              ? "skill-library-target"
              : "skill-library-target skill-library-target-empty"
          }
          aria-label="当前添加目标"
        >
          <span className="skill-library-target-avatar">
            {activeAgent ? activeAgent.name.slice(0, 1) : <AppIcon name="users" />}
          </span>
          <span className="skill-library-target-copy">
            <strong>{activeAgent ? `当前 Agent：${activeAgent.name}` : "先选择一个 Agent"}</strong>
            <small>
              {activeAgent
                ? `已添加 ${activeAgentSkillIds.size} 个技能点`
                : "从左侧可用 Agent 列表中选择目标后，可以在这里添加技能点。"}
            </small>
          </span>
        </section>
        {actionError ? (
          <p className="skill-library-action-error" role="alert">
            {actionError}
          </p>
        ) : null}

        <div className="skill-library-toolbar">
          <label className="skill-library-search">
            <AppIcon name="search" />
            <input
              aria-label="搜索技能点"
              placeholder="搜索技能点..."
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <select
            aria-label="技能分类筛选"
            value={selectedCategory}
            onChange={(event) => setSelectedCategory(event.target.value)}
          >
            <option value={ALL_CATEGORIES}>全部技能</option>
            {catalog.map((category) => (
              <option key={category.name} value={category.name}>
                {category.name}
              </option>
            ))}
          </select>
        </div>

        <header className="skill-library-header">
          <div>
            <span className="eyebrow">Skill Collection</span>
            <h3>{activeCategory?.name ?? "全部技能点"}</h3>
          </div>
          <p>
            共 <strong>{visibleSkills.length}</strong> 个技能点
          </p>
        </header>

        {loadState.status === "loading" ? (
          <div className="skill-library-state" role="status">
            正在加载技能点...
          </div>
        ) : loadState.status === "error" ? (
          <div className="skill-library-state skill-library-state-error" role="alert">
            {loadState.message}
          </div>
        ) : visibleSkills.length === 0 ? (
          <div className="skill-library-state">当前没有匹配的技能点</div>
        ) : (
          <div className="skill-library-grid">
            {visibleSkills.map((skill) => {
              const isAdded = activeAgentSkillIds.has(skill.id);
              const pendingAction =
                pendingSkillAction?.skillId === skill.id ? pendingSkillAction.type : null;
              const isToggleDisabled = !activeAgent || pendingSkillAction !== null;
              const cardClassName = isAdded
                ? "skill-library-card skill-library-card-added"
                : "skill-library-card";
              const statusLabel =
                pendingAction === "add"
                  ? "添加中"
                  : pendingAction === "remove"
                    ? "移除中"
                    : isAdded
                      ? "已添加"
                      : null;

              return (
                <article className={cardClassName} key={skill.id}>
                  {statusLabel ? (
                    <span className="skill-library-card-status">{statusLabel}</span>
                  ) : null}
                  <div className="skill-library-card-icon">
                    <AppIcon name={categoryIconMap[skill.category] ?? "sparkle"} />
                  </div>
                  <div className="skill-library-card-copy">
                    <strong>{skill.name}</strong>
                    <p tabIndex={0}>{skill.description || "暂无描述"}</p>
                  </div>
                  <footer>
                    <span>{skill.category}</span>
                    <button
                      type="button"
                      aria-label={
                        activeAgent
                          ? isAdded
                            ? `从 ${activeAgent.name} 取消添加 ${skill.name}`
                            : `添加 ${skill.name} 到 ${activeAgent.name}`
                          : `先选择 Agent 后添加 ${skill.name}`
                      }
                      title={isAdded ? "取消添加" : "添加"}
                      disabled={isToggleDisabled}
                      onClick={() => void handleToggleSkill(skill)}
                    >
                      <AppIcon name={isAdded ? "check" : "plus"} />
                    </button>
                  </footer>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
