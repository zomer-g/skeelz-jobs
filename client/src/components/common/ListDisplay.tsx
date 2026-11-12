import ListGroup from 'react-bootstrap/ListGroup';
import { keyValue } from '../../models/interfaces/Props.interfaces';

type ListDisplayProps = {
  items: keyValue[]; // Array of keyValue objects to display
};

function ListDisplay({ items }: ListDisplayProps) {
  let values: string[] = []; // Declare `values` outside the conditional blocks

  // Check if items is an array and handle accordingly
  if (Array.isArray(items)) {
    values = items.map(item => item.value); // Assuming `keyValue` has a `value` property
  } else if (typeof items === "object" && items !== null) {
    values = Object.values(items); // Extract values if it's an object
  }

  return (
    <ListGroup>
      {values.map((item, index) => (
        <ListGroup.Item className="font-RubikRegular" key={index}>
          {item}
        </ListGroup.Item>
      ))}
    </ListGroup>
  );
}

export default ListDisplay;
