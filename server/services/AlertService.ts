export interface OperationalAlert {
  id: string;
  type: 'latency' | 'cpu' | 'encoder_stall' | 'stream_failed' | 'storage_warning' | 'destination_disconnected';
  severity: 'warning' | 'critical';
  title: string;
  message: string;
  value?: number;
  threshold?: number;
  streamId?: string;
  streamTitle?: string;
  timestamp: string;
  dismissed: boolean;
}

export class AlertService {
  private static alerts: OperationalAlert[] = [];
  private static alertCooldowns = new Map<string, number>();
  private static COOLDOWN_MS = 60 * 1000; // 60s cooldown for duplicate alerts

  public static addAlert(alert: Omit<OperationalAlert, 'id' | 'timestamp' | 'dismissed'>): OperationalAlert | null {
    const key = `${alert.type}_${alert.streamId || 'global'}_${alert.severity}`;
    const now = Date.now();
    const lastTriggered = this.alertCooldowns.get(key) || 0;

    if (now - lastTriggered < this.COOLDOWN_MS) {
      return null; // Suppressed by cooldown
    }

    this.alertCooldowns.set(key, now);

    const fullAlert: OperationalAlert = {
      ...alert,
      id: `alt_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      timestamp: new Date().toISOString(),
      dismissed: false,
    };

    this.alerts.unshift(fullAlert);
    if (this.alerts.length > 200) {
      this.alerts = this.alerts.slice(0, 150);
    }

    return fullAlert;
  }

  public static getAlerts(includeDismissed = false): OperationalAlert[] {
    if (includeDismissed) {
      return [...this.alerts];
    }
    return this.alerts.filter(a => !a.dismissed);
  }

  public static dismissAlert(id: string): boolean {
    const found = this.alerts.find(a => a.id === id);
    if (found) {
      found.dismissed = true;
      return true;
    }
    return false;
  }

  public static clearAllAlerts(): void {
    for (const a of this.alerts) {
      a.dismissed = true;
    }
  }
}
