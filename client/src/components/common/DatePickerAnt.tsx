import React from 'react';
import { ConfigProvider, DatePicker, Space } from 'antd';
import heIL from 'antd/locale/he_IL'; // Hebrew locale
import dayjs from 'dayjs';
import 'dayjs/locale/he'; // Hebrew locale for dayjs

// Set Hebrew locale for Day.js
dayjs.locale('he');

interface DatePickerAntProps {
  value?: Date | null; // Expect value to be a Date object, not a string
  onChange: (date: Date | null) => void; // Ensure onChange expects a Date object
}

const DatePickerAnt: React.FC<DatePickerAntProps> = ({ value, onChange }) => {
  const handleDateChange = (date: dayjs.Dayjs | null, dateString: string | string[]) => {
    // Convert the dayjs object to a Date object when calling onChange
    onChange(date ? date.toDate() : null);
  };

  return (
    <ConfigProvider locale={heIL}>
      <Space direction="vertical">
        <DatePicker
          format="DD/MM/YYYY" // Change the format to "day/month/year"
          value={value ? dayjs(value) : undefined} // Convert Date object to dayjs for display
          onChange={handleDateChange} // Pass the Date object to onChange
          style={{
            borderRadius: '8px',
            padding: '8px',
            borderColor: '#98A2B3',
            fontSize: '16px',
            width: '320px',
            height: '48px',
          }}
        />
      </Space>
    </ConfigProvider>
  );
};

export default DatePickerAnt;
