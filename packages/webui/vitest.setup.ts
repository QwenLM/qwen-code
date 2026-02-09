// React 18/19: mark tests as act-enabled to avoid act environment warnings.
const globalWithAct = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

globalWithAct.IS_REACT_ACT_ENVIRONMENT = true;
