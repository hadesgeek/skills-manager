import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, Plus, Square, SquareCheck, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { cn } from "../utils";
import type { ManagedSkill, Scenario } from "../lib/tauri";

export interface PresetWorkspaceAgent {
  key: string;
  display_name: string;
  enabled: boolean;
  installed: boolean;
}

export interface PresetWorkspaceActionResult {
  added: number;
  removed: number;
  skipped: number;
  failed: number;
}

type PresetWorkspaceAction = "add" | "remove";

interface Props {
  open: boolean;
  title: string;
  presets: Scenario[];
  managedSkills: ManagedSkill[];
  agents: PresetWorkspaceAgent[];
  initialPresetId?: string | null;
  initialSelectedAgents?: string[];
  onClose: () => void;
  existsInWorkspace: (skill: ManagedSkill, agentKey: string) => boolean;
  onAddSkill: (skill: ManagedSkill, agentKey: string) => Promise<void>;
  onRemoveSkill: (skill: ManagedSkill, agentKey: string) => Promise<void>;
  onComplete: (result: PresetWorkspaceActionResult) => Promise<void> | void;
}

export function PresetWorkspaceActionDialog({
  open,
  title,
  presets,
  managedSkills,
  agents,
  initialPresetId,
  initialSelectedAgents,
  onClose,
  existsInWorkspace,
  onAddSkill,
  onRemoveSkill,
  onComplete,
}: Props) {
  const { t } = useTranslation();
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [action, setAction] = useState<PresetWorkspaceAction>("add");
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);
  const [selectedRemoveSkillIds, setSelectedRemoveSkillIds] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);

  const availableAgents = useMemo(
    () => agents.filter((agent) => agent.installed),
    [agents]
  );

  const defaultAgentKeys = useMemo(() => {
    const valid = new Set(availableAgents.map((agent) => agent.key));
    const fromInitial = (initialSelectedAgents ?? []).filter((key) => valid.has(key));
    if (fromInitial.length > 0) return Array.from(new Set(fromInitial));

    const enabled = availableAgents.filter((agent) => agent.enabled).map((agent) => agent.key);
    if (enabled.length > 0) return enabled;
    return availableAgents.map((agent) => agent.key);
  }, [availableAgents, initialSelectedAgents]);

  useEffect(() => {
    if (!open) return;
    const initialPreset =
      (initialPresetId && presets.some((preset) => preset.id === initialPresetId) && initialPresetId) ||
      presets[0]?.id ||
      "";
    setSelectedPresetId(initialPreset);
    setAction("add");
    setSelectedAgents(defaultAgentKeys);
    setSelectedRemoveSkillIds(new Set());
    setRunning(false);
  }, [defaultAgentKeys, initialPresetId, open, presets]);

  const selectedPreset = useMemo(
    () => presets.find((preset) => preset.id === selectedPresetId) ?? null,
    [presets, selectedPresetId]
  );

  const presetSkills = useMemo(
    () => managedSkills.filter((skill) => selectedPresetId && skill.scenario_ids.includes(selectedPresetId)),
    [managedSkills, selectedPresetId]
  );

  const selectedAgentSet = useMemo(() => new Set(selectedAgents), [selectedAgents]);

  const addRows = useMemo(() => presetSkills.map((skill) => {
    const missingAgents = selectedAgents.filter((agentKey) => !existsInWorkspace(skill, agentKey));
    return { skill, missingAgents };
  }), [existsInWorkspace, presetSkills, selectedAgents]);

  const missingPairCount = useMemo(
    () => addRows.reduce((sum, row) => sum + row.missingAgents.length, 0),
    [addRows]
  );

  const totalPairCount = presetSkills.length * selectedAgents.length;
  const skippedPairCount = Math.max(totalPairCount - missingPairCount, 0);

  const removeRows = useMemo(() => presetSkills.map((skill) => {
    const installedAgents = selectedAgents.filter((agentKey) => existsInWorkspace(skill, agentKey));
    return { skill, installedAgents };
  }), [existsInWorkspace, presetSkills, selectedAgents]);

  const removableRows = useMemo(
    () => removeRows.filter((row) => row.installedAgents.length > 0),
    [removeRows]
  );

  const removableKey = useMemo(
    () => removableRows.map((row) => `${row.skill.id}:${row.installedAgents.join(",")}`).join("|"),
    [removableRows]
  );

  useEffect(() => {
    if (!open || action !== "remove") return;
    setSelectedRemoveSkillIds(new Set(removableRows.map((row) => row.skill.id)));
  }, [action, open, removableKey, removableRows]);

  const selectedRemoveRows = useMemo(
    () => removableRows.filter((row) => selectedRemoveSkillIds.has(row.skill.id)),
    [removableRows, selectedRemoveSkillIds]
  );

  const selectedRemovePairCount = useMemo(
    () => selectedRemoveRows.reduce((sum, row) => sum + row.installedAgents.length, 0),
    [selectedRemoveRows]
  );

  const toggleAgent = useCallback((key: string) => {
    setSelectedAgents((prev) => (
      prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]
    ));
  }, []);

  const toggleRemoveSkill = useCallback((skillId: string) => {
    setSelectedRemoveSkillIds((prev) => {
      const next = new Set(prev);
      if (next.has(skillId)) next.delete(skillId);
      else next.add(skillId);
      return next;
    });
  }, []);

  const handleSubmit = async () => {
    if (!selectedPreset) return;
    if (selectedAgents.length === 0) {
      toast.error(t("presetActions.selectAgents"));
      return;
    }

    setRunning(true);
    const result: PresetWorkspaceActionResult = { added: 0, removed: 0, skipped: 0, failed: 0 };
    try {
      if (action === "add") {
        for (const row of addRows) {
          for (const agentKey of selectedAgents) {
            if (existsInWorkspace(row.skill, agentKey)) {
              result.skipped++;
              continue;
            }
            try {
              await onAddSkill(row.skill, agentKey);
              result.added++;
            } catch {
              result.failed++;
            }
          }
        }
      } else {
        for (const row of selectedRemoveRows) {
          for (const agentKey of row.installedAgents) {
            try {
              await onRemoveSkill(row.skill, agentKey);
              result.removed++;
            } catch {
              result.failed++;
            }
          }
        }
      }

      await onComplete(result);

      if (result.added > 0) {
        toast.success(t("presetActions.addedToast", { added: result.added, skipped: result.skipped }));
      } else if (result.removed > 0) {
        toast.success(t("presetActions.removedToast", { removed: result.removed }));
      } else if (result.failed === 0) {
        toast.info(action === "add" ? t("presetActions.nothingToAdd") : t("presetActions.nothingToRemove"));
      }
      if (result.failed > 0) {
        toast.error(t("presetActions.partialFailedToast", { count: result.failed }));
      }

      if (result.added > 0 || result.removed > 0) {
        onClose();
      }
    } finally {
      setRunning(false);
    }
  };

  if (!open) return null;

  const submitDisabled =
    running ||
    !selectedPreset ||
    selectedAgents.length === 0 ||
    presetSkills.length === 0 ||
    (action === "add" ? missingPairCount === 0 : selectedRemovePairCount === 0);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => !running && onClose()} />
      <div className="relative flex max-h-[calc(100vh-2rem)] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border-subtle bg-bg-secondary shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-border-subtle px-5 py-4">
          <h2 className="text-[14px] font-semibold text-primary">{title}</h2>
          <button
            onClick={onClose}
            disabled={running}
            className="rounded-[4px] p-1.5 text-muted transition-colors hover:bg-surface-hover hover:text-secondary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="shrink-0 space-y-3 border-b border-border-subtle px-5 py-4">
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-muted">{t("presetActions.preset")}</span>
            <select
              value={selectedPresetId}
              onChange={(event) => setSelectedPresetId(event.target.value)}
              className="app-input w-full"
              disabled={running || presets.length === 0}
            >
              {presets.length === 0 ? (
                <option value="">{t("presetActions.noPresets")}</option>
              ) : presets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name} ({preset.skill_count})
                </option>
              ))}
            </select>
          </label>

          <div>
            <div className="mb-1.5 text-[12px] font-medium text-muted">{t("presetActions.action")}</div>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setAction("add")}
                disabled={running}
                className={cn(
                  "flex items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-[13px] font-medium transition-colors",
                  action === "add"
                    ? "border-accent-border bg-accent-bg text-accent-light"
                    : "border-border-subtle text-muted hover:border-border hover:text-secondary"
                )}
              >
                <Plus className="h-3.5 w-3.5" />
                {t("presetActions.addMissing")}
              </button>
              <button
                onClick={() => setAction("remove")}
                disabled={running}
                className={cn(
                  "flex items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-[13px] font-medium transition-colors",
                  action === "remove"
                    ? "border-red-500/30 bg-red-500/10 text-red-500"
                    : "border-border-subtle text-muted hover:border-border hover:text-secondary"
                )}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t("presetActions.removeMatching")}
              </button>
            </div>
            <p className="mt-1.5 text-[12px] leading-snug text-muted">
              {action === "add" ? t("presetActions.addHelp") : t("presetActions.removeHelp")}
            </p>
          </div>

          <div>
            <div className="mb-1.5 text-[12px] font-medium text-muted">{t("presetActions.agents")}</div>
            <div className="flex flex-wrap gap-2">
              {availableAgents.map((agent) => {
                const active = selectedAgentSet.has(agent.key);
                return (
                  <button
                    key={agent.key}
                    onClick={() => toggleAgent(agent.key)}
                    disabled={running}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-medium transition-colors",
                      active
                        ? "border-accent-border bg-accent-bg text-accent-light"
                        : "border-border-subtle text-muted hover:border-border hover:text-secondary"
                    )}
                  >
                    {active ? <SquareCheck className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
                    {agent.display_name}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hide">
          {presetSkills.length === 0 ? (
            <div className="py-12 text-center text-[13px] text-muted">
              {selectedPreset ? t("presetActions.noPresetSkills") : t("presetActions.noPresets")}
            </div>
          ) : action === "add" ? (
            <div className="divide-y divide-border-subtle">
              {addRows.map(({ skill, missingAgents }) => (
                <div key={skill.id} className="flex items-center gap-3 px-5 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-primary">{skill.name}</div>
                    {skill.description && (
                      <div className="mt-0.5 truncate text-[12px] text-muted">{skill.description}</div>
                    )}
                  </div>
                  <span className={cn(
                    "shrink-0 rounded-full px-2 py-0.5 text-[12px] font-medium",
                    missingAgents.length > 0 ? "bg-accent-bg text-accent-light" : "bg-surface-hover text-muted"
                  )}>
                    {missingAgents.length > 0
                      ? t("presetActions.willAddToAgents", { count: missingAgents.length })
                      : t("presetActions.alreadyInSelectedAgents")}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="divide-y divide-border-subtle">
              {removeRows.map(({ skill, installedAgents }) => {
                const removable = installedAgents.length > 0;
                const checked = selectedRemoveSkillIds.has(skill.id);
                return (
                  <button
                    key={skill.id}
                    onClick={() => removable && toggleRemoveSkill(skill.id)}
                    disabled={!removable || running}
                    className={cn(
                      "flex w-full items-center gap-3 px-5 py-2.5 text-left transition-colors",
                      removable ? "hover:bg-surface-hover" : "cursor-not-allowed opacity-60"
                    )}
                  >
                    {removable
                      ? checked
                        ? <SquareCheck className="h-3.5 w-3.5 shrink-0 text-red-500" />
                        : <Square className="h-3.5 w-3.5 shrink-0 text-faint" />
                      : <Square className="h-3.5 w-3.5 shrink-0 text-faint" />}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium text-primary">{skill.name}</div>
                      {skill.description && (
                        <div className="mt-0.5 truncate text-[12px] text-muted">{skill.description}</div>
                      )}
                    </div>
                    <span className={cn(
                      "shrink-0 rounded-full px-2 py-0.5 text-[12px] font-medium",
                      removable ? "bg-red-500/10 text-red-500" : "bg-surface-hover text-muted"
                    )}>
                      {removable
                        ? t("presetActions.installedInAgents", { count: installedAgents.length })
                        : t("presetActions.notInstalled")}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-border-subtle bg-bg-secondary px-5 py-3">
          <div className="mb-3 text-[12px] text-muted">
            {action === "add"
              ? t("presetActions.addSummary", { count: missingPairCount, skipped: skippedPairCount })
              : t("presetActions.removeSummary", { count: selectedRemovePairCount })}
          </div>
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={onClose}
              disabled={running}
              className="rounded-md border border-border-subtle px-3 py-2 text-[13px] font-medium text-muted transition-colors hover:border-border hover:text-secondary disabled:opacity-50"
            >
              {t("common.cancel")}
            </button>
            <button
              onClick={handleSubmit}
              disabled={submitDisabled}
              className={cn(
                "inline-flex min-w-[132px] items-center justify-center gap-1.5 rounded-md px-3 py-2 text-[13px] font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                action === "remove" ? "bg-red-500 hover:bg-red-600" : "bg-accent hover:bg-accent-hover"
              )}
            >
              {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {action === "add"
                ? t("presetActions.addButton", { count: missingPairCount })
                : t("presetActions.removeButton", { count: selectedRemovePairCount })}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
