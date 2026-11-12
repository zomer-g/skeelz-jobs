import {ReactNode } from 'react';

interface NoSSRProps {
  children: ReactNode;
  isServer: boolean;
}

const NoSSR: React.FC<NoSSRProps> = ({ children ,isServer }) => {

  return !isServer ? <>{children}</> : null;
};

export default NoSSR;
