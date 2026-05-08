import { useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, Globe, Layers, Loader2, Plus, Search, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { cn } from "../utils";
import { useApp } from "../context/AppContext";
import { PresetWorkspaceActionDialog } from "../components/PresetWorkspaceActionDialog";
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
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                        selected
                          ? "border-accent bg-accent text-white"
                          : "border-border-subtle bg-transparent"
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
  const { t } = useTranslation();
  const { tools, managedSkills, scenarios, refreshManagedSkills, refreshTools } = useApp();

  const [showPresetDialog, setShowPresetDialog] = useState(false);
  const [addDialogAgentKey, setAddDialogAgentKey] = useState<string | null>(null);
  const [removingKey, setRemovingKey] = useState<string | null>(null);
  const [collapsedAgents, setCollapsedAgents] = useState<Set<string>>(new Set());

  const toggleCollapse = useCallback((agentKey: string) => {
    setCollapsedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(agentKey)) next.delete(agentKey);
      else next.add(agentKey);
      return next;
    });
  }, []);

  const installedTools = useMemo(() => tools.filter((tool) => tool.installed), [tools]);

  const skillsByAgent = useMemo(() => {
    const map: Record<string, ManagedSkill[]> = {};
    for (const tool of tools) {
      map[tool.key] = managedSkills.filter((skill) =>
        skill.targets.some((target) => target.tool === tool.key)
      );
    }
    return map;
  }, [tools, managedSkills]);

  const globalWorkspaceAgents = useMemo(
    () =>
      tools.map((tool) => ({
        key: tool.key,
        display_name: tool.display_name,
        enabled: tool.enabled,
        installed: tool.installed,
      })),
    [tools]
  );

  const existsInGlobal = useCallback(
    (skill: ManagedSkill, agentKey: string) =>
      skill.targets.some((target) => target.tool === agentKey),
    []
  );

  const handlePresetAdd = useCallback(async (skill: ManagedSkill, agentKey: string) => {
    await api.syncSkillToTool(skill.id, agentKey);
  }, []);

  const handlePresetRemove = useCallback(async (skill: ManagedSkill, agentKey: string) => {
    await api.unsyncSkillFromTool(skill.id, agentKey);
  }, []);

  const handlePresetComplete = useCallback(async () => {
    await Promise.all([refreshManagedSkills(), refreshTools()]);
  }, [refreshManagedSkills, refreshTools]);

  const handleRemove = async (skill: ManagedSkill, agentKey: string) => {
    const key = `${skill.id}:${agentKey}`;
    setRemovingKey(key);
    try {
      await api.unsyncSkillFromTool(skill.id, agentKey);
      await Promise.all([refreshManagedSkills(), refreshTools()]);
      toast.success(t("globalWorkspace.removedToast", { name: skill.name }));
    } catch (e) {
      toast.error(getErrorMessage(e, t("common.error")));
    } finally {
      setRemovingKey(null);
    }
  };

  const addDialogAgent = addDialogAgentKey
    ? (tools.find((tool) => tool.key === addDialogAgentKey) ?? null)
    : null;

  const addDialogInstalledIds = useMemo((): Set<string> => {
    if (!addDialogAgentKey) return new Set();
    return new Set(
      managedSkills
        .filter((skill) => skill.targets.some((target) => target.tool === addDialogAgentKey))
        .map((skill) => skill.id)
    );
  }, [addDialogAgentKey, managedSkills]);

  const handleAddSkills = useCallback(
    async (skillIds: string[]) => {
      if (!addDialogAgentKey) return;
      for (const skillId of skillIds) {
        await api.syncSkillToTool(skillId, addDialogAgentKey);
      }
      await Promise.all([refreshManagedSkills(), refreshTools()]);
      toast.success(t("globalWorkspace.addedToast", { count: skillIds.length }));
      setAddDialogAgentKey(null);
    },
    [addDialogAgentKey, refreshManagedSkills, refreshTools, t]
  );

  return (
    <div className="app-page">
      <div className="app-page-header">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="app-page-title">{t("globalWorkspace.title")}</h1>
            <p className="app-page-subtitle">{t("globalWorkspace.subtitle")}</p>
          </div>
          <button
            onClick={() => setShowPresetDialog(true)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border-subtle bg-background px-3 py-2 text-[13px] font-medium text-secondary transition-colors hover:border-border hover:bg-surface-hover"
          >
            <Layers className="h-3.5 w-3.5" />
            {t("presetActions.button")}
          </button>
        </div>
      </div>

      {installedTools.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Globe className="mb-3 h-10 w-10 text-faint" />
          <p className="text-[14px] font-medium text-secondary">{t("globalWorkspace.noAgents")}</p>
          <p className="mt-1 text-[13px] text-muted">{t("globalWorkspace.noAgentsHint")}</p>
        </div>
      ) : (
        <div className="space-y-5">
          {installedTools.map((tool) => {
            const agentSkills = skillsByAgent[tool.key] ?? [];
            const collapsed = collapsedAgents.has(tool.key);
            return (
              <div key={tool.key} className="rounded-xl border border-border-subtle">
                <div className={cn(
                  "flex items-center justify-between gap-3 px-5 py-3",
                  !collapsed && "border-b border-border-subtle"
                )}>
                  <button
                    onClick={() => toggleCollapse(tool.key)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    {collapsed
                      ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted" />
                      : <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted" />}
                    <span className="text-[14px] font-semibold text-primary">{tool.display_name}</span>
                    <span className="rounded-full bg-surface-hover px-2 py-0.5 text-[12px] font-medium text-muted">
                      {t("globalWorkspace.skillCount", { count: agentSkills.length })}
                    </span>
                  </button>
                  {!collapsed && (
                    <button
                      onClick={() => setAddDialogAgentKey(tool.key)}
                      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border-subtle px-2.5 py-1.5 text-[12px] font-medium text-muted transition-colors hover:border-border hover:text-secondary"
                    >
                      <Plus className="h-3 w-3" />
                      {t("globalWorkspace.addSkill")}
                    </button>
                  )}
                </div>

                {!collapsed && (agentSkills.length === 0 ? (
                  <div className="px-5 py-8 text-center text-[13px] text-muted">
                    {t("globalWorkspace.noSkillsForAgent")}
                  </div>
                ) : (
                  <div className="divide-y divide-border-subtle">
                    {agentSkills.map((skill) => {
                      const key = `${skill.id}:${tool.key}`;
                      const removing = removingKey === key;
                      return (
                        <div key={skill.id} className="flex items-center gap-3 px-5 py-2.5">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[13px] font-medium text-primary">
                              {skill.name}
                            </div>
                            {skill.description && (
                              <div className="mt-0.5 truncate text-[12px] text-muted">
                                {skill.description}
                              </div>
                            )}
                          </div>
                          <button
                            onClick={() => handleRemove(skill, tool.key)}
                            disabled={removing}
                            className="shrink-0 rounded-md p-1.5 text-faint transition-colors hover:bg-red-500/10 hover:text-red-500 disabled:opacity-50"
                            title={t("globalWorkspace.removeSkill")}
                          >
                            {removing ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="h-3.5 w-3.5" />
                            )}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}

      <PresetWorkspaceActionDialog
        open={showPresetDialog}
        title={t("presetActions.applyToGlobal")}
        presets={scenarios}
        managedSkills={managedSkills}
        agents={globalWorkspaceAgents}
        onClose={() => setShowPresetDialog(false)}
        existsInWorkspace={existsInGlobal}
        onAddSkill={handlePresetAdd}
        onRemoveSkill={handlePresetRemove}
        onComplete={handlePresetComplete}
      />

      {addDialogAgent && (
        <AddSkillDialog
          agent={addDialogAgent}
          managedSkills={managedSkills}
          installedSkillIds={addDialogInstalledIds}
          onAdd={handleAddSkills}
          onClose={() => setAddDialogAgentKey(null)}
        />
      )}
    </div>
  );
}
