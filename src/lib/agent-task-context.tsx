import { createContext, useContext } from 'react';
import { defaultLiveTaskId } from './live-tasks';
export const AgentTaskContext = createContext(defaultLiveTaskId);
export const useAgentTaskId = () => useContext(AgentTaskContext);
