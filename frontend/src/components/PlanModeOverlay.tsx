import { useState, useRef, useEffect } from 'preact/hooks';
import { approvePlan, rejectPlan, panes } from '../store';
import type { PaneState } from '../store';

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

  return (
    <div class="plan-mode-overlay">
      <div class="plan-mode-header">
        <span class="plan-mode-badge">Plan Mode</span>
        <span class="plan-mode-title">{pane.agentName} is planning...</span>
      </div>

      <div class="plan-mode-content">
        <pre class="plan-mode-text">{pane.planContent || 'Loading plan...'}</pre>
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
