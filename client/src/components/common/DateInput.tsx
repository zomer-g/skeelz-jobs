import React from 'react';
import { ConfigProvider, DatePicker, Space } from 'antd';
import heIL from 'antd/locale/he_IL'; // Hebrew locale
import dayjs from 'dayjs';
import 'dayjs/locale/he'; // Hebrew locale for dayjs
import Label from './Label';
import FieldErrorMessageComponent from './FieldErrorMessage';

// Set Hebrew locale for Day.js
dayjs.locale('he');

interface DateInputProps {
  name: string;
  value?: Date | null; // Expect value to be a Date object, not a string
  label?: string;
  labelClassName?: string;
  className?: string;
  error?: string | null;
  touched?: boolean;
  onChange: (date: Date | null) => void; // Ensure onChange expects a Date object
  required?: boolean;
}

const DateInput: React.FC<DateInputProps> = ({ value,name, onChange,label,labelClassName,error,required}) => {
  const handleDateChange = (date: dayjs.Dayjs | null, dateString: string | string[]) => {
    // Convert the dayjs object to a Date object when calling onChange
    onChange(date ? date.toDate() : null);
  };

  return (
    <div className="max-width-20rem w-100" style={{ position: 'relative' }}>
    {label && (
      <div >
        <Label
          htmlFor={name}
          required={required}
          className={`font-RubikRegular ${labelClassName}`}
        >
          {label}
        </Label>
      </div>
    )}
    <ConfigProvider locale={heIL}>
      <Space direction="vertical" className="w-100">
        <DatePicker
          picker="date"
          format="DD/MM/YYYY" // Change the format to "day/month/year"
          value={value ? dayjs(value) : undefined} // Convert Date object to dayjs for display
          onChange={handleDateChange} // Pass the Date object to onChange
          inputReadOnly={true}
          style={{
            borderRadius: '8px',
            padding: '8px',
            borderColor: '#98A2B3',
            fontSize: '16px',
            width: '100%', // Ensures it fits within the parent div
            maxWidth: '100%', // Prevents overflow
            boxSizing: 'border-box', // Ensures padding is included in the width
            height: '48px',
          }}
        />
      </Space>
    </ConfigProvider>
    {error && <FieldErrorMessageComponent error={error} />}
  </div>
  );
};

export default DateInput;
