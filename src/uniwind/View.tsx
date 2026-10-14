import { View as RNView, type ViewProps } from 'react-native';
import { copyComponentProperties } from 'uniwind-internal/components/utils';
import { useEngineRef, useShadewindStyle } from './useShadewindStyle';

type Props = ViewProps & { className?: string };

export const View = copyComponentProperties(RNView, (props: Props) => {
  const { style, themed } = useShadewindStyle(props.className, props);
  const ref = useEngineRef(themed, (props as { ref?: any }).ref);

  return <RNView {...props} ref={ref} style={[style, props.style]} />;
});

export default View;
