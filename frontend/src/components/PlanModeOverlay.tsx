import { useState, useRef, useEffect } from 'preact/hooks';
import { approvePlan, rejectPlan, panes } from '../store';
import type { PaneState } from '../store';
import { MarkdownViewer } from './MarkdownViewer';

interface Props {
  pane: PaneState;
}

export function PlanModeOverlay({ pane }: Props) {
  const [feedback, setFeedback] = useState('');
  const [showRejectInput, setShowRejectInput] = useState(false);
  const feedbackRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (showRejectInput) {
      feedbackRef.current?.focus();
    }
  }, [showRejectInput]);

  if (!pane.planMode) return null;

  const handleApprove = () => {
    approvePlan(pane.id);
  };

  const handleReject = () => {
    if (showRejectInput) {
      rejectPlan(pane.id, feedback.trim() || undefined);
      setFeedback('');
      setShowRejectInput(false);
    } else {
      setShowRejectInput(true);
    }
  };

  const handleCopy = async () => {
    if (!pane.planContent) return;
    try {
      await navigator.clipboard.writeText(pane.planContent);
    } catch {}
  };

  return (
    <div class="plan-mode-overlay">
      <div class="plan-mode-header">
        <span class="plan-mode-badge">Plan Mode</span>
        <span class="plan-mode-title">{pane.agentName} is planning...</span>
        <button class="plan-btn cancel" onClick={handleCopy}>Copy</button>
      </div>

      <div class="plan-mode-content">
        <MarkdownViewer className="plan-mode-markdown" content={pane.planContent || 'Loading plan...'} />
      </div>

      <div class="plan-mode-actions">
        {showRejectInput ? (
          <div class="plan-reject-form">
            <textarea
              ref={feedbackRef}
              class="plan-feedback-input"
              value={feedback}
              onChange={(e) => setFeedback((e.target as HTMLTextAreaElement).value)}
              placeholder="Optional feedback for the agent..."
              rows={3}
            />
            <div class="plan-reject-buttons">
              <button class="plan-btn cancel" onClick={() => setShowRejectInput(false)}>
                Cancel
              </button>
              <button class="plan-btn reject" onClick={handleReject}>
                Reject Plan
              </button>
            </div>
          </div>
        ) : (
          <>
            <button class="plan-btn approve" onClick={handleApprove}>
              Approve Plan
            </button>
            <button class="plan-btn request-changes" onClick={handleReject}>
              Request Changes
            </button>
          </>
        )}
      </div>
    </div>
  );
}
