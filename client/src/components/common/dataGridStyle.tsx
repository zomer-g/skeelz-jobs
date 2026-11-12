export const dataGridStyle = {
    border: 0,
    overflowX: 'auto',

    // "& .MuiTablePagination-displayedRows": {
    //       direction: "rtl", // Change to right-to-left
    //     },

    '& .MuiTablePagination-actions': {

      padding: '8px',
      marginBottom: '1rem',
       // Adjust padding
    },

    '& .MuiDataGrid-cell:focus': {
      outline: 'none',
      boxShadow: 'none',
    },

    '& .MuiDataGrid-cell.MuiDataGrid-cell--textLeft': { 
      fontFamily: 'RubikRegularFont', // Replace with your desired font
      fontSize: '14px', // Adjust the font size as needed
      color: '#333', // Change text color
    },
    '& .MuiToolbar-root, & .MuiTablePagination-toolbar': {
            fontFamily: 'font-RubikRegularFont', // Update with your desired font
            fontSize: '14px', // Adjust font size
            color: '#333', // Font color
            // direction: 'ltr',
    },
    '& .MuiDataGrid-cell': {
      textAlign: 'justify;', // or 'left' / 'right'
    },

    '& .MuiDataGrid-columnHeader:focus': {
      outline: 'none', // Removes focus outline
    },
    '& .MuiDataGrid-columnHeader:focus-within': {
      outline: 'none', // Removes focus outline for child elements as well
    },

    //remove SVG filter and sort
    '& .MuiSvgIcon-root.MuiSvgIcon-fontSizeInherit': {
        pointerEvents: 'none', // Disable click interaction
        display: 'none', // Hide the sort icon
        // Remove hover effect by overriding any hover styles
        '&:hover': {
          backgroundColor: 'transparent', // Remove background hover color
          opacity: 0, // Keep opacity consistent when hovering (optional)
        },
      },
      
    '& .MuiDataGrid-columnHeaderTitle': {
      display: 'flex', // Ensure title remains visible
    },
    '& .MuiDataGrid-sortIcon': {
      display: 'none', // Hide the sort icon
    },
  

    // Targeting the DataGrid's root and scrollbar thumb
    '& .MuiDataGrid-root': { // Update with your desired font
         '& .MuiDataGrid-cell': {
            fontFamily: 'font-RubikRegularFont', // Cell font family
            fontSize: '14px', // Cell font size
            color: '#555', // Cell font color
          },
        '&::-webkit-scrollbar': {
            height: '8px', // Set height for the horizontal scrollbar
            width: '8px', // Set width for vertical scrollbar
        },
        '&::-webkit-scrollbar-thumb': {
            backgroundColor: '#bdbdbd', // Scrollbar color
            borderRadius: '20px', // Set the border-radius for scrollbar thumb
        },
        '&::-webkit-scrollbar-track': {
            backgroundColor: 'transparent', // Make the track transparent
            borderRadius: '20px', // Apply rounded corners to the track
        },
    },

    '& .MuiDataGrid-row:hover': {
        backgroundColor: '#FFE7FF',  // Change this to the color you want
    },
    '& .MuiDataGrid-columnHeader': {
        backgroundColor: '#EFEFEF !important',  // Add !important to make sure it applies
    },

    "& .MuiDataGrid-scrollbar--vertical": {
      display: "none", // Completely hides the vertical scrollbar
    },
    // Custom scrollbar styling for the virtual scroller (which handles the scrolling area)
    '& .MuiDataGrid-virtualScroller': {

        overflowY: "hidden",
        
        '&::-webkit-scrollbar': {
            width: '8px', // Scrollbar width
            height: '8px', // Horizontal scrollbar height
        },
        '&::-webkit-scrollbar-thumb': {
            backgroundColor: '#888', // Scrollbar color
            borderRadius: '20px', // Set the border-radius for scrollbar thumb
        },
        '&::-webkit-scrollbar-track': {
            backgroundColor: '#f1f1f1', // Track color
            borderRadius: '20px', // Track border radius
        },
        '&::-webkit-scrollbar-corner': {
            backgroundColor: 'transparent',
        },
    },

    // Custom scrollbar styling for horizontal scrollbar specifically
    '& .MuiDataGrid-scrollbar.MuiDataGrid-scrollbar--horizontal.css-ad8qk9': {
        position: 'absolute',
        display: 'inline-block',
        zIndex: 6,
        '--size': 'calc(max(var(--DataGrid-scrollbarSize), 4px))',
        width: '100%',
        height: 'var(--size)',
        overflowY: 'hidden',
        overflowX: 'auto',
        outline: 0,
        bottom: '0px',
        borderRadius: '20px', // Rounded corners
    },

    '& .MuiDataGrid-scrollbar.MuiDataGrid-scrollbar--horizontal.css-ad8qk9::-webkit-scrollbar': {
        height: '8px', // Horizontal scrollbar height
    },

    '& .MuiDataGrid-scrollbar.MuiDataGrid-scrollbar--horizontal.css-ad8qk9::-webkit-scrollbar-thumb': {
        backgroundColor: '#D0D5DD', // Scrollbar thumb color
        borderRadius: '20px', // Rounded thumb
    },

    '& .MuiDataGrid-scrollbar.MuiDataGrid-scrollbar--horizontal.css-ad8qk9::-webkit-scrollbar-track': {
        backgroundColor: '#f1f1f1', // Track color
        borderRadius: '20px', // Rounded corners for the track
    },

    "& .MuiTablePagination-root": {
      overflow: "unset", // Remove the overflow property
    },
};
