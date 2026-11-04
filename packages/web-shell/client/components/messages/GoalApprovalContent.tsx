import { useState } from 'react';
import { useI18n } from '../../i18n';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { sanitizeControlChars } from './toolFormatting';
import styles from './ToolApproval.module.css';

const sectionLabels: Record<string, string> = {
  Outcome: 'approval.goal.outcome',
  'Done when': 'approval.goal.doneWhen',
  'Must not': 'approval.goal.mustNot',
  Budget: 'approval.goal.budget',
  'On block': 'approval.goal.onBlock',
  Context: 'approval.goal.context',
};

function splitSections(objective: string) {
  const matches = [
    ...objective.matchAll(
      /(?:^|\s)(Outcome|Done when|Must not|Budget|On block|Context):\s*/g,
    ),
  ];
  // Only format the draft convention; arbitrary objectives remain verbatim.
  if (
    matches[0]?.[1] !== 'Outcome' ||
    objective.slice(0, matches[0].index).trim()
  ) {
    return [];
  }
  return matches.map((match, index) => ({
    label: sectionLabels[match[1]],
    text: objective
      .slice(
        match.index + match[0].length,
        matches[index + 1]?.index ?? objective.length,
      )
      .trim(),
  }));
}

export function GoalApprovalContent({
  objective,
  content,
  id,
}: {
  objective: string;
  content: string;
  id: string;
}) {
  const { t } = useI18n();
  const [view, setView] = useState('overview');
  const sections = splitSections(objective);
  const fullText = content || objective;
  const objectiveDisplay = sanitizeControlChars(objective);
  const fullTextDisplay = sanitizeControlChars(fullText);
  const sectionDisplays = sections.map((section) => ({
    ...section,
    text: sanitizeControlChars(section.text),
  }));
  // Confirmation text can warn that an existing goal will be replaced. Keep
  // that notice in the overview too, rather than hiding it behind a tab.
  const trimmedObjective = objective.trim();
  const prompt = fullText.trimEnd();
  const noticeText =
    trimmedObjective && prompt.endsWith(trimmedObjective)
      ? prompt.slice(0, -trimmedObjective.length).trim()
      : fullText !== objective
        ? fullText
        : '';
  const notice = sanitizeControlChars(noticeText);

  return (
    <Tabs
      value={view}
      onValueChange={setView}
      className={styles.goalTabs}
      data-approval-shortcuts-ignore
    >
      <TabsList variant="line" aria-label={t('approval.goal.title')}>
        <TabsTrigger value="overview">
          {t('approval.goal.overview')}
        </TabsTrigger>
        <TabsTrigger value="full">{t('approval.goal.full')}</TabsTrigger>
      </TabsList>
      <div className={styles.goalBody} id={id}>
        <TabsContent value="overview" className={styles.goalPanel}>
          {objective && notice && <p className={styles.goalNotice}>{notice}</p>}
          {sectionDisplays.length ? (
            sectionDisplays.map((section, index) => (
              <section key={index} className={styles.goalSection}>
                <h3>{t(section.label)}</h3>
                <p>{section.text}</p>
              </section>
            ))
          ) : (
            <p>{objective ? objectiveDisplay : fullTextDisplay}</p>
          )}
        </TabsContent>
        <TabsContent value="full" className={styles.goalPanel}>
          <p>{fullTextDisplay}</p>
        </TabsContent>
      </div>
    </Tabs>
  );
}
