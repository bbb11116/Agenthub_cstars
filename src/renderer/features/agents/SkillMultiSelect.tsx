import { useMemo, useState } from "react";
import type { AgentSkillCategory, AgentSkillSummary } from "../../../shared/types";

type SkillMultiSelectProps = {
  catalog: AgentSkillCategory[];
  selectedSkillIds: string[];
  disabled?: boolean;
  loading?: boolean;
  error?: string | null;
  onChange: (skillIds: string[]) => void;
};

function includesQuery(skill: AgentSkillSummary, query: string): boolean {
  if (!query) return true;
  const searchable = `${skill.name} ${skill.description} ${skill.category}`.toLowerCase();
  return searchable.includes(query.toLowerCase());
}

export function SkillMultiSelect({
  catalog,
  selectedSkillIds,
  disabled = false,
  loading = false,
  error = null,
  onChange
}: SkillMultiSelectProps) {
  const [query, setQuery] = useState("");
  const selected = useMemo(() => new Set(selectedSkillIds), [selectedSkillIds]);
  const filteredCatalog = useMemo(
    () =>
      catalog
        .map((category) => ({
          ...category,
          skills: category.skills.filter((skill) => includesQuery(skill, query.trim()))
        }))
        .filter((category) => category.skills.length > 0),
    [catalog, query]
  );

  function toggleSkill(skillId: string): void {
    if (disabled) return;
    const next = new Set(selectedSkillIds);
    if (next.has(skillId)) {
      next.delete(skillId);
    } else {
      next.add(skillId);
    }
    onChange([...next]);
  }

  return (
    <section className="skill-multi-select">
      <div className="skill-multi-select-header">
        <span>技能</span>
        <span>已选 {selectedSkillIds.length} 项</span>
      </div>
      <input
        disabled={disabled}
        placeholder="搜索技能"
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {loading ? <p className="skill-multi-select-note">正在加载技能...</p> : null}
      {error ? <p className="skill-multi-select-error">{error}</p> : null}
      {!loading && !error && filteredCatalog.length === 0 ? (
        <p className="skill-multi-select-note">未找到技能。</p>
      ) : null}
      <div className="skill-multi-select-list">
        {filteredCatalog.map((category) => (
          <div className="skill-multi-select-category" key={category.name}>
            <h4>{category.name}</h4>
            {category.skills.map((skill) => (
              <label className="skill-multi-select-item" key={skill.id}>
                <input
                  checked={selected.has(skill.id)}
                  disabled={disabled}
                  type="checkbox"
                  onChange={() => toggleSkill(skill.id)}
                />
                <span>
                  <strong>{skill.name}</strong>
                  {skill.description ? <small>{skill.description}</small> : null}
                </span>
              </label>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
