import { useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useParams, useNavigate } from "react-router-dom";
import {
  CheckCircle2,
  ChevronRight,
  Globe,
  LayoutGrid,
  List,
  Loader2,
  Plus,
  Search,
  Square,
  SquareCheck,
  Trash2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { cn } from "../utils";
import { useApp } from "../context/AppContext";
import { useMultiSelect } from "../hooks/useMultiSelect";
import { MultiSelectToolbar } from "../components/MultiSelectToolbar";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { PresetBar } from "../components/PresetBar";
import { getTagColor, getTagActiveColor } from "../lib/skillTags";
import * as api from "../lib/tauri";
import type { ManagedSkill, ToolInfo } from "../lib/tauri";
import { getErrorMessage } from "../lib/error";

function AddSkillDialog({
  agent,
  managedSkills,
  installedSkillIds,
  onAdd,
  onClose,
}: {
  agent: ToolInfo;
  managedSkills: ManagedSkill[];
  installedSkillIds: Set<string>;
  onAdd: (skillIds: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);

  const available = useMemo(
    () =>
      managedSkills.filter(
        (skill) =>
          !installedSkillIds.has(skill.id) &&
          (search === "" ||
            skill.name.toLowerCase().includes(search.toLowerCase()) ||
            (skill.description || "").toLowerCase().includes(search.toLowerCase()))
      ),
    [installedSkillIds, managedSkills, search]
  );

  const toggleSelect = (skillId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(skillId)) next.delete(skillId);
      else next.add(skillId);
      return next;
    });
  };

  const handleAdd = async () => {
    if (selectedIds.size === 0) return;
    setAdding(true);
    try {
      await onAdd(Array.from(selectedIds));
    } finally {
      setAdding(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => !adding && onClose()}
      />
      <div className="relative flex max-h-[calc(100vh-2rem)] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border-subtle bg-bg-secondary shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-border-subtle px-5 py-4">
          <h2 className="text-[14px] font-semibold text-primary">
            {t("globalWorkspace.addSkillDialogTitle", { agent: agent.display_name })}
          </h2>
          <button
            onClick={onClose}
            disabled={adding}
            className="rounded-[4px] p-1.5 text-muted transition-colors hover:bg-surface-hover hover:text-secondary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="shrink-0 border-b border-border-subtle px-4 py-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("globalWorkspace.addSkillSearch")}
              className="app-input w-full pl-8"
              autoFocus
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hide">
          {available.length === 0 ? (
            <div className="py-12 text-center text-[13px] text-muted">
              {installedSkillIds.size >= managedSkills.length && search === ""
                ? t("globalWorkspace.allInstalled")
                : t("globalWorkspace.noSkillsMatch")}
            </div>
          ) : (
            <div className="divide-y divide-border-subtle">
              {available.map((skill) => {
                const selected = selectedIds.has(skill.id);
                return (
                  <button
                    key={skill.id}
                    onClick={() => toggleSelect(skill.id)}
                    disabled={adding}
                    className={cn(
                      "flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-surface-hover",
                      selected && "bg-accent-bg"
                    )}
                  >
                    <div
                      className={cn(
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
                        selected
                          ? "border-accent bg-accent text-white"
                          : "border-border bg-transparent"
                      )}
                    >
                      {selected && (
                        <svg viewBox="0 0 16 16" fill="currentColor" className="h-3 w-3">
                          <path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z" />
                        </svg>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium text-primary">{skill.name}</div>
                      {skill.description && (
                        <div className="mt-0.5 truncate text-[12px] text-muted">{skill.description}</div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-border-subtle px-5 py-3">
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={onClose}
              disabled={adding}
              className="rounded-md border border-border-subtle px-3 py-2 text-[13px] font-medium text-muted transition-colors hover:border-border hover:text-secondary disabled:opacity-50"
            >
              {t("common.cancel")}
            </button>
            <button
              onClick={handleAdd}
              disabled={adding || selectedIds.size === 0}
              className="inline-flex min-w-[120px] items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-2 text-[13px] font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {t("globalWorkspace.addButton", { count: selectedIds.size })}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

export function GlobalWorkspace() {
  const { agentKey } = useParams<{ agentKey?: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { tools, managedSkills, scenarios, refreshManagedSkills, refreshTools } = useApp();

  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [search, setSearch] = useState("");
  const [tagFilters, setTagFilters] = useState<Set<string>>(new Set());
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [batchRemoveConfirm, setBatchRemoveConfirm] = useState(false);
  const [batchRemoving, setBatchRemoving] = useState(false);

  const installedTools = useMemo(() => tools.filter((t) => t.installed && t.enabled), [tools]);

  const presetBarAgentKeys = useMemo(
    () => agentKey ? [agentKey] : installedTools.map((t) => t.key),
    [agentKey, installedTools]
  );

  const skillCountByAgent = useMemo(() => {
    const map: Record<string, number> = {};
    for (const tool of installedTools) {
      map[tool.key] = managedSkills.filter((s) =>
        s.targets.some((target) => target.tool === tool.key)
      ).length;
    }
    return map;
  }, [installedTools, managedSkills]);

  const currentTool = useMemo(
    () => (agentKey ? tools.find((t) => t.key === agentKey) ?? null : null),
    [agentKey, tools]
  );

  const allTags = useMemo(() => {
    const tags = new Set<string>();
    for (const skill of managedSkills) {
      for (const tag of skill.tags) {
        if (tag.trim()) tags.add(tag);
      }
    }
    return Array.from(tags).sort((a, b) => a.localeCompare(b));
  }, [managedSkills]);

  const agentSkills = useMemo(
    () =>
      agentKey
        ? managedSkills.filter((skill) =>
            skill.targets.some((target) => target.tool === agentKey)
          )
        : [],
    [agentKey, managedSkills]
  );

  const filtered = useMemo(() => {
    let result = agentSkills;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (skill) =>
          skill.name.toLowerCase().includes(q) ||
          (skill.description || "").toLowerCase().includes(q)
      );
    }
    if (tagFilters.size > 0) {
      result = result.filter((skill) => skill.tags.some((tag) => tagFilters.has(tag)));
    }
    return result;
  }, [agentSkills, search, tagFilters]);

  const {
    isMultiSelect, setIsMultiSelect,
    selectedIds,
    toggleSelect,
    isAllSelected,
    anyDisabled,
    handleSelectAll,
    exitMultiSelect,
  } = useMultiSelect({
    items: agentSkills,
    filtered,
    getKey: (s) => s.id,
    isItemActive: () => true,
  });

  const installedIds = useMemo(
    () => new Set(agentSkills.map((s) => s.id)),
    [agentSkills]
  );

  const toggleTagFilter = (tag: string) => {
    setTagFilters((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };

  const handleRemove = async (skill: ManagedSkill) => {
    if (!agentKey) return;
    setRemovingId(skill.id);
    try {
      await api.unsyncSkillFromTool(skill.id, agentKey);
      await Promise.all([refreshManagedSkills(), refreshTools()]);
      toast.success(t("globalWorkspace.removedToast", { name: skill.name }));
    } catch (e) {
      toast.error(getErrorMessage(e, t("common.error")));
    } finally {
      setRemovingId(null);
    }
  };

  const handleBatchRemove = async () => {
    if (!agentKey) return;
    setBatchRemoving(true);
    const ids = Array.from(selectedIds);
    let removed = 0;
    let failed = 0;
    for (const skillId of ids) {
      try {
        await api.unsyncSkillFromTool(skillId, agentKey);
        removed++;
      } catch {
        failed++;
      }
    }
    await Promise.all([refreshManagedSkills(), refreshTools()]);
    if (removed > 0) toast.success(t("globalWorkspace.batchRemoved", { count: removed }));
    if (failed > 0) toast.error(t("globalWorkspace.batchRemoveFailed", { count: failed }));
    exitMultiSelect();
    setBatchRemoveConfirm(false);
    setBatchRemoving(false);
  };

  const handleAddSkills = useCallback(
    async (skillIds: string[]) => {
      if (!agentKey) return;
      for (const skillId of skillIds) {
        await api.syncSkillToTool(skillId, agentKey);
      }
      await Promise.all([refreshManagedSkills(), refreshTools()]);
      toast.success(t("globalWorkspace.addedToast", { count: skillIds.length }));
      setAddDialogOpen(false);
    },
    [agentKey, refreshManagedSkills, refreshTools, t]
  );

  const existsInGlobal = useCallback(
    (skill: ManagedSkill, agentK: string) =>
      skill.targets.some((target) => target.tool === agentK),
    []
  );

  const handlePresetAdd = useCallback(async (skill: ManagedSkill, agentK: string) => {
    await api.syncSkillToTool(skill.id, agentK);
  }, []);

  const handlePresetRemove = useCallback(async (skill: ManagedSkill, agentK: string) => {
    await api.unsyncSkillFromTool(skill.id, agentK);
  }, []);

  const handlePresetComplete = useCallback(async () => {
    await Promise.all([refreshManagedSkills(), refreshTools()]);
  }, [refreshManagedSkills, refreshTools]);

  if (installedTools.length === 0) {
    return (
      <div className="app-page">
        <div className="app-panel flex flex-col items-center justify-center py-16 text-center">
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-surface-hover">
            <Globe className="h-5 w-5 text-muted" />
          </div>
          <p className="text-[13px] font-medium text-secondary">{t("globalWorkspace.noAgents")}</p>
          <p className="mt-1 max-w-[260px] text-[12px] leading-relaxed text-muted">
            {t("globalWorkspace.noAgentsHint")}
          </p>
        </div>
      </div>
    );
  }

  if (!currentTool) {
    return (
      <div className="app-page">
        <div className="app-page-header pr-2 flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="app-page-title flex items-center gap-2.5">
              <Globe className="h-5 w-5 text-accent" />
              {t("globalWorkspace.title")}
            </h1>
            <p className="app-page-subtitle">{t("globalWorkspace.subtitle")}</p>
          </div>
          <div />
        </div>

        {/* Preset bar — all agents scope */}
        {scenarios.length > 0 && (
          <PresetBar
            presets={scenarios}
            managedSkills={managedSkills}
            agentKeys={presetBarAgentKeys}
            existsInWorkspace={existsInGlobal}
            onAddSkill={handlePresetAdd}
            onRemoveSkill={handlePresetRemove}
            onComplete={handlePresetComplete}
          />
        )}

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {installedTools.map((tool) => {
            const count = skillCountByAgent[tool.key] ?? 0;
            return (
              <button
                key={tool.key}
                onClick={() => navigate(`/global-workspace/${tool.key}`)}
                className="app-panel group flex items-center gap-3 p-3.5 text-left transition-all hover:border-border hover:bg-surface-hover"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-muted group-hover:text-secondary">
                  <Globe className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-semibold text-secondary">{tool.display_name}</p>
                  <p className="text-[12px] text-muted">{t("globalWorkspace.skillCount", { count })}</p>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-faint transition-transform group-hover:translate-x-0.5" />
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="app-page">
      {/* Header */}
      <div className="app-page-header pr-2 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="app-page-title flex items-center gap-2.5">
            <Globe className="h-5 w-5 text-accent" />
            {currentTool.display_name}
            <span className="app-badge">{agentSkills.length}</span>
          </h1>
          <p className="app-page-subtitle">{t("globalWorkspace.subtitle")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-1">
          <button
            onClick={() => setAddDialogOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-[13px] font-medium text-white transition-colors hover:bg-accent-hover"
          >
            <Plus className="h-3.5 w-3.5" />
            {t("globalWorkspace.addSkill")}
          </button>
        </div>
      </div>

      {/* Toolbar */}
      <div className="app-toolbar">
        <div className="flex flex-1 gap-3">
          <div className="relative w-full max-w-[280px]">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("globalWorkspace.addSkillSearch")}
              className="app-input w-full pl-9 font-medium"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>
        </div>

        <div className="app-segmented">
          <button
            onClick={() => setViewMode("grid")}
            className={cn(
              "rounded-md p-2 transition-colors outline-none",
              viewMode === "grid" ? "bg-surface-active text-secondary" : "text-muted hover:text-tertiary"
            )}
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
          <button
            onClick={() => setViewMode("list")}
            className={cn(
              "rounded-md p-2 transition-colors outline-none",
              viewMode === "list" ? "bg-surface-active text-secondary" : "text-muted hover:text-tertiary"
            )}
          >
            <List className="h-4 w-4" />
          </button>
          <button
            onClick={() => (isMultiSelect ? exitMultiSelect() : setIsMultiSelect(true))}
            className={cn(
              "rounded-md p-2 transition-colors outline-none",
              isMultiSelect ? "bg-surface-active text-secondary" : "text-muted hover:text-tertiary"
            )}
            title={isMultiSelect ? t("globalWorkspace.cancelSelect") : t("globalWorkspace.selectMode")}
          >
            <SquareCheck className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Tag filters */}
      {allTags.length > 0 && (
        <div className="mb-1.5 flex flex-wrap items-center gap-1 px-1 -mt-2">
          <span className="text-[12px] text-muted">{t("mySkills.tags.filter")}</span>
          <button
            onClick={() => setTagFilters(new Set())}
            className={cn(
              "rounded-full px-2.5 py-0.5 text-[12px] font-medium transition-colors",
              tagFilters.size === 0
                ? "bg-accent text-white"
                : "bg-surface-hover text-muted hover:text-secondary"
            )}
          >
            {t("mySkills.tags.allTags")}
          </button>
          {allTags.map((tag) => {
            const active = tagFilters.has(tag);
            return (
              <button
                key={tag}
                onClick={() => toggleTagFilter(tag)}
                className={cn(
                  "rounded-full px-2.5 py-0.5 text-[12px] font-medium transition-colors",
                  active ? getTagActiveColor(tag, allTags) : getTagColor(tag, allTags)
                )}
              >
                {tag}
              </button>
            );
          })}
        </div>
      )}

      {/* Preset bar */}
      {scenarios.length > 0 && (
        <PresetBar
          presets={scenarios}
          managedSkills={managedSkills}
          agentKeys={presetBarAgentKeys}
          existsInWorkspace={existsInGlobal}
          onAddSkill={handlePresetAdd}
          onRemoveSkill={handlePresetRemove}
          onComplete={handlePresetComplete}
        />
      )}

      {/* Multi-select toolbar */}
      {isMultiSelect && (
        <MultiSelectToolbar
          selectedCount={selectedIds.size}
          isAllSelected={isAllSelected}
          anyDisabled={anyDisabled}
          showToggle={false}
          labels={{
            hint: t("globalWorkspace.selectHint"),
            selected: t("globalWorkspace.selectedCount", { count: selectedIds.size }),
            delete: t("globalWorkspace.deleteSelected", { count: selectedIds.size }),
            enable: "",
            disable: "",
            selectAll: t("globalWorkspace.selectAll"),
            deselectAll: t("globalWorkspace.deselectAll"),
            cancel: t("common.cancel"),
          }}
          onDelete={() => setBatchRemoveConfirm(true)}
          onToggle={() => {}}
          onSelectAll={handleSelectAll}
          onCancel={exitMultiSelect}
        />
      )}

      {/* Skills */}
      {filtered.length === 0 ? (
        agentSkills.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center pb-20 text-center">
            <Globe className="mb-4 h-12 w-12 text-faint" />
            <h3 className="mb-1.5 text-[14px] font-semibold text-tertiary">
              {t("globalWorkspace.noSkillsForAgent")}
            </h3>
            <button
              onClick={() => setAddDialogOpen(true)}
              className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-accent-hover"
            >
              <Plus className="h-3.5 w-3.5" />
              {t("globalWorkspace.addSkill")}
            </button>
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center pb-20 text-center">
            <p className="text-[13px] text-muted">{t("mySkills.noMatch")}</p>
          </div>
        )
      ) : (
        <div
          className={cn(
            "pb-8",
            viewMode === "grid"
              ? "grid grid-cols-2 gap-3 lg:grid-cols-3"
              : "flex flex-col gap-0.5"
          )}
        >
          {filtered.map((skill) => {
            const removing = removingId === skill.id;
            const isSelected = selectedIds.has(skill.id);

            if (viewMode === "grid") {
              return (
                <div
                  key={skill.id}
                  className={cn(
                    "app-panel group relative flex h-full flex-col transition-all hover:border-border hover:bg-surface-hover",
                    isMultiSelect && "cursor-pointer",
                    isMultiSelect && isSelected && "ring-1 ring-accent border-accent/40"
                  )}
                  onClick={isMultiSelect ? () => toggleSelect(skill.id) : undefined}
                >
                  <div className="flex items-center gap-2.5 px-3.5 pt-3 pb-1.5">
                    {isMultiSelect ? (
                      isSelected
                        ? <SquareCheck className="h-3.5 w-3.5 shrink-0 text-accent" />
                        : <Square className="h-3.5 w-3.5 shrink-0 text-faint" />
                    ) : (
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                    )}
                    <h3
                      className="flex-1 truncate text-[14px] font-semibold text-primary"
                      title={skill.name}
                    >
                      {skill.name}
                    </h3>
                  </div>

                  <div className="px-3.5 pb-3">
                    <p className="truncate text-[13px] leading-[18px] text-muted">
                      {skill.description || "—"}
                    </p>
                    {skill.tags.length > 0 && (
                      <div className="mt-2 flex flex-wrap items-center gap-1">
                        {skill.tags.map((tag) => (
                          <span
                            key={tag}
                            className={cn(
                              "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
                              getTagColor(tag, allTags)
                            )}
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="mt-auto flex items-center justify-end border-t border-border-subtle px-3.5 py-2">
                    {!isMultiSelect && (
                      <button
                        onClick={() => handleRemove(skill)}
                        disabled={removing}
                        title={t("globalWorkspace.removeSkill")}
                        className="rounded p-1 text-faint opacity-0 transition-all group-hover:opacity-100 hover:bg-red-500/10 hover:text-red-500 disabled:opacity-50"
                      >
                        {removing
                          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          : <Trash2 className="h-3.5 w-3.5" />}
                      </button>
                    )}
                  </div>
                </div>
              );
            }

            // List view
            return (
              <div
                key={skill.id}
                className={cn(
                  "app-panel group flex items-center gap-3.5 rounded-xl border-transparent px-3.5 py-3 transition-all hover:border-border hover:bg-surface-hover",
                  isMultiSelect && "cursor-pointer",
                  isMultiSelect && isSelected && "ring-1 ring-accent border-accent/40"
                )}
                onClick={isMultiSelect ? () => toggleSelect(skill.id) : undefined}
              >
                {isMultiSelect ? (
                  isSelected
                    ? <SquareCheck className="h-3.5 w-3.5 shrink-0 text-accent" />
                    : <Square className="h-3.5 w-3.5 shrink-0 text-faint" />
                ) : (
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                )}
                <h3
                  className="w-[180px] shrink-0 truncate text-[14px] font-semibold text-secondary"
                  title={skill.name}
                >
                  {skill.name}
                </h3>
                <p className="min-w-0 flex-1 truncate text-[13px] text-muted">
                  {skill.description || "—"}
                </p>
                {skill.tags.length > 0 && (
                  <div className="flex shrink-0 items-center gap-1.5">
                    {skill.tags.map((tag) => (
                      <span
                        key={tag}
                        className={cn(
                          "inline-flex items-center rounded-full px-1.5 py-0.5 text-[11px] font-medium",
                          getTagColor(tag, allTags)
                        )}
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
                {!isMultiSelect && (
                  <button
                    onClick={() => handleRemove(skill)}
                    disabled={removing}
                    title={t("globalWorkspace.removeSkill")}
                    className="shrink-0 rounded p-0.5 text-faint opacity-0 transition-all group-hover:opacity-100 hover:bg-red-500/10 hover:text-red-500 disabled:opacity-50"
                  >
                    {removing
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <Trash2 className="h-3.5 w-3.5" />}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {addDialogOpen && currentTool && (
        <AddSkillDialog
          agent={currentTool}
          managedSkills={managedSkills}
          installedSkillIds={installedIds}
          onAdd={handleAddSkills}
          onClose={() => setAddDialogOpen(false)}
        />
      )}

      <ConfirmDialog
        open={batchRemoveConfirm}
        title={t("globalWorkspace.removeSkill")}
        message={t("globalWorkspace.batchRemoveConfirm", {
          count: selectedIds.size,
          agent: currentTool.display_name,
        })}
        tone="danger"
        confirmLabel={batchRemoving ? undefined : t("globalWorkspace.deleteSelected", { count: selectedIds.size })}
        onClose={() => setBatchRemoveConfirm(false)}
        onConfirm={handleBatchRemove}
      />
    </div>
  );
}
