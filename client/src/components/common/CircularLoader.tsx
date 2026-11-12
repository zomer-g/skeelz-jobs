import React from 'react';
import CircularProgress from '@mui/material/CircularProgress';
import Box from '@mui/material/Box';

interface CircularLoaderProps {
  size?: number; 
  color?:  'primary' | 'secondary' | 'success' | 'inherit'| 'error';
  className?: string;
}

const CircularLoader: React.FC<CircularLoaderProps> = ({ size = 40, color = 'primary', className = '' }) => {
  return (
    <div className={className}>
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
        <CircularProgress size={size} color={color} />
      </Box>
    </div>
  );
};

export default CircularLoader;