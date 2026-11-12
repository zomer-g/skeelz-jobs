import Form from 'react-bootstrap/cjs/Form';
import InputGroup from 'react-bootstrap/cjs/InputGroup';
import React, { useState } from 'react';
import Button from 'react-bootstrap/cjs/Button';
import 'bootstrap-icons/font/bootstrap-icons.css';
import { CircleWithCross } from '../../icons';
import { i18n } from '../../i18n/I18n';

interface SearchBarProps {
  searchTerm: string;
  setSearchTerm: (value: string) => void;
  handleSearch: (customString?: string) => void;
  noResults?: boolean;
  placeHolderText?: string;
  clearSearch: () => void; 
}

function SearchBar({ searchTerm: inputValue, setSearchTerm, handleSearch, noResults = false, placeHolderText = '', clearSearch }: SearchBarProps) {
  const [isFocused, setIsFocused] = useState(false);
  const translations = i18n.getTranslations();
  // Delay hiding the button on blur to allow time for clicking
  const handleBlur = () => {
    if (!inputValue) {
      setTimeout(() => setIsFocused(false), 100); // Small delay
    }
  };

  const handleClearSearch = () => {
    setIsFocused(false);
    clearSearch();
    handleSearch('');
  };

  const handleKeyPress = (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
          handleSearch();
      }
      if (event.key === 'Backspace' || event.key === 'Delete') {
      const currentValue = (event.currentTarget as HTMLInputElement).value;
      if (currentValue === '') {
        handleSearch('');
      }
    }
  };

  return (
    <InputGroup className="position-relative input-with-icon">

      <Form.Control
        value={inputValue}
        onKeyUp={handleKeyPress}
        onChange={(e) => {
          setSearchTerm(e.target.value)
        }}
        className={`custom-placeholder ps-5 fs-6 p-3 custom-shadow h-3rem w-100 rounded-pill ps-5 pe-5 ${
          noResults ? ' border-color-red' : 'border-color-grey'
        }`}
        placeholder={isFocused ? '' : placeHolderText}
        aria-label="Search"
        onFocus={() => setIsFocused(true)}
        onBlur={handleBlur}
      />
      <i
        className={`bi bi-search search-icon fs-4 position-absolute top-50 translate-middle-y ms-3 ${
          isFocused ? 'text-black' : 'text-secondary'
        }`}
      ></i>
      {inputValue && (
      <CircleWithCross
        color='black'
        className={`crossInsideSearchBar xs-crossInsideSearchBar fs-3 position-absolute`}
        onClick={handleClearSearch}
       />
       )}
      <Button
        onMouseDown={()=>{handleSearch()}} // Use onMouseDown to capture the click before blur
        className={`position-absolute z-index-5 start-0 search-button rounded-end-0 rounded-pill w-118px xs-w-48px h-100 ${
          noResults ? 'bg-color-peach text-color-red border-color-red' : 'bg-black text-white border-0'
          } ${isFocused ? 'd-block' : 'd-none'}`}
      >
        <span className="font-RubikSmall d-none d-sm-inline">{translations.SearchBar.Search}</span>
        <i className="bi bi-search search-icon text-light d-inline d-sm-none"></i>
      </Button>

      {/* Invisible overlay div to prevent typing in the right 20% */}
      <div className="position-absolute end-0 top-0 h-100 bg-transparent z-index-4 width-20 pe-none"></div>
    </InputGroup>
  );
}

export default SearchBar;
