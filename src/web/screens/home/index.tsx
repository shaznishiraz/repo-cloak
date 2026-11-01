import { Placeholder } from '../../shell/placeholder.js';

export function HomeScreen({ workspaceId }: { workspaceId?: string | undefined }) {
  return <Placeholder title="Workspaces" package="10-home" detail={workspaceId} />;
}
